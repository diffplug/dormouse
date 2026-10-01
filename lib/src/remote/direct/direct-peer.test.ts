/**
 * The peer wrapper over the linked fake pair (`docs/specs/remote-api.md` ->
 * Transport -> "Direct path"): one negotiation, one channel, and the four ways
 * it can end. The end-to-end cases that drive it inside a real session are in
 * `../client/pocket-client.test.ts` and `../burrow/burrow-runtime.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DIRECT_ANSWER_TIMEOUT_MS,
  DIRECT_BUFFER_HIGH,
  DIRECT_CHANNEL_LABEL,
  DIRECT_DISCONNECTED_GRACE_MS,
  DIRECT_GATHER_TIMEOUT_MS,
  DIRECT_SETUP_TIMEOUT_MS,
  DIRECT_SRFLX_GRACE_MS,
  MAX_DIRECT_PENDING_BYTES,
  MAX_DIRECT_PENDING_FRAMES,
  NOISE_MAX_MESSAGE_LENGTH,
} from 'remote-lib-common';

import {
  DIRECT_PATH_RECHECK_MS,
  DirectPeer,
  type DirectPathPolicy,
  type DirectPeerHandlers,
} from './direct-peer';
import {
  FAKE_LAN_PAIR,
  FakeDirectNetwork,
  OFF_LAN_PAIR as OFF_LAN,
  flushMicrotasks,
  lanOnlyPolicy,
  type FakeDirectNetworkOptions,
} from './test-fake-peer';
import { fakeTimers, type FakeTimers } from '../test-timers';

/** Every report one end hears; a path policy's violations are `refusals`. */
function handlers(): DirectPeerHandlers & {
  frames: Uint8Array[];
  opens: number;
  closes: string[];
  violations: string[];
  refusals: string[];
} {
  const record = {
    frames: [] as Uint8Array[],
    opens: 0,
    closes: [] as string[],
    violations: [] as string[],
    refusals: [] as string[],
    onOpen: () => void (record.opens += 1),
    onFrame: (frame: Uint8Array) => void record.frames.push(frame),
    onClosed: (reason: string) => void record.closes.push(reason),
    onViolation: (reason: string, cause?: string) =>
      void (cause === 'path-refused' ? record.refusals : record.violations).push(reason),
  };
  return record;
}

/**
 * Both ends of one negotiation, sharing a clock the test drives; the Burrow's
 * held to `burrowPolicy` where a case gives one.
 */
function pair(options: FakeDirectNetworkOptions = {}, burrowPolicy?: DirectPathPolicy) {
  const network = new FakeDirectNetwork(options);
  const timers = fakeTimers();
  const client = handlers();
  const burrow = handlers();
  const offerer = network.createOfferer();
  const answerer = network.createAnswerer();
  return {
    network,
    timers,
    client,
    burrow,
    /** The connections themselves, for the cases that move their state. */
    offerer,
    answerer,
    clientPeer: new DirectPeer({ peer: offerer, handlers: client, setTimer: timers.setTimer }),
    burrowPeer: new DirectPeer({
      peer: answerer,
      handlers: burrow,
      pathPolicy: burrowPolicy,
      setTimer: timers.setTimer,
    }),
  };
}

/** Every deadline still armed, by its delay, in the order each was armed. */
const liveDelays = (timers: FakeTimers): number[] => timers.live.map((timer) => timer.delayMs);

/** One negotiated pair with both channels open, as most cases start. */
async function connected(options: FakeDirectNetworkOptions = {}, burrowPolicy?: DirectPathPolicy) {
  const run = pair(options, burrowPolicy);
  const offer = await run.clientPeer.offer();
  await run.clientPeer.acceptAnswer((await run.burrowPeer.answer(offer!))!);
  await flushMicrotasks();
  return run;
}

describe('DirectPeer', () => {
  it('negotiates one ordered channel and carries raw bytes both ways', async () => {
    const { network, clientPeer, burrowPeer, client, burrow } = pair();

    const offer = await clientPeer.offer();
    expect(offer).toContain('m=application');
    const answer = await burrowPeer.answer(offer!);
    expect(answer).toContain('a=setup:active');
    await clientPeer.acceptAnswer(answer!);
    await flushMicrotasks();

    expect(client.opens).toBe(1);
    expect(burrow.opens).toBe(1);
    expect(clientPeer.isOpen).toBe(true);
    // The label is fixed: one channel per session, named the same at both ends.
    expect(network.offererChannel!.label).toBe(DIRECT_CHANNEL_LABEL);
    // Set before a frame can arrive, so every message is bytes.
    expect(network.offererChannel!.binaryType).toBe('arraybuffer');

    clientPeer.send(Uint8Array.of(1, 2, 3));
    burrowPeer.send(Uint8Array.of(4, 5));
    await flushMicrotasks();

    expect(burrow.frames).toEqual([Uint8Array.of(1, 2, 3)]);
    expect(client.frames).toEqual([Uint8Array.of(4, 5)]);
  });

  it('sends the description it has at the deadline when only host candidates arrive', async () => {
    const { offerer, clientPeer, timers } = pair({ gathering: 'pending' });

    const offering = clientPeer.offer();
    let settled = false;
    void offering.then(() => (settled = true));
    await flushMicrotasks();
    offerer.gatherCandidate('host');
    offerer.gatherCandidate(null);
    await flushMicrotasks();
    // Nothing to send yet: there is no trickle path, so the SDP waits — and
    // neither a host candidate nor end-of-candidates starts the grace.
    expect(settled).toBe(false);
    expect(liveDelays(timers)).toEqual([
      DIRECT_SETUP_TIMEOUT_MS,
      DIRECT_GATHER_TIMEOUT_MS,
    ]);

    timers.fireAt(DIRECT_GATHER_TIMEOUT_MS);
    const sent = await offering;
    expect(sent).toContain('m=application');
    // The description carries what was gathered, each candidate once.
    expect(sent!.match(/ typ host\b/g)).toHaveLength(1);
    // One that arrives after the description went arms nothing.
    offerer.gatherCandidate('srflx');
    expect(liveDelays(timers)).toEqual([DIRECT_SETUP_TIMEOUT_MS]);
  });

  it('sends a grace after the first server-reflexive candidate, without waiting out the deadline', async () => {
    const { offerer, clientPeer, timers } = pair({ gathering: 'pending' });

    const offering = clientPeer.offer();
    await flushMicrotasks();
    offerer.gatherCandidate('host');
    offerer.gatherCandidate('srflx');
    const grace = timers.live.at(-1);
    // A second family's, inside the grace, neither restarts nor extends it.
    offerer.gatherCandidate('srflx', { address: '2001:db8::7' });
    expect(timers.live.at(-1)).toBe(grace);
    expect(liveDelays(timers)).toEqual([
      DIRECT_SETUP_TIMEOUT_MS,
      DIRECT_GATHER_TIMEOUT_MS,
      DIRECT_SRFLX_GRACE_MS,
    ]);

    timers.fireAt(DIRECT_SRFLX_GRACE_MS);
    // What was gathered by then travels with it, both families.
    const sent = await offering;
    expect(sent).toContain(' 203.0.113.7 9 typ srflx ');
    expect(sent).toContain(' 2001:db8::7 9 typ srflx ');
    // The deadline went with it; only the setup one is still armed.
    expect(liveDelays(timers)).toEqual([DIRECT_SETUP_TIMEOUT_MS]);
  });

  /**
   * The `icecandidate` string is spelled by the stack: a browser's is
   * `candidate:… typ srflx …`, the case above, and `node-datachannel`'s
   * polyfill hands up the SDP line itself, `a=candidate:… typ srflx raddr …
   * rport …`. The event alone arms the grace here, the description the wait
   * began with holding no srflx. The live spellings, and when each end settled
   * on them, are checked by hand by `scripts/direct-interop/run.mjs --stun`.
   */
  it('starts the grace on a server-reflexive candidate in the polyfill’s spelling', async () => {
    const { offerer, clientPeer, timers } = pair({ gathering: 'pending' });

    const offering = clientPeer.offer();
    await flushMicrotasks();
    offerer.gatherCandidate('srflx', { form: 'polyfill' });
    expect(liveDelays(timers)).toEqual([
      DIRECT_SETUP_TIMEOUT_MS,
      DIRECT_GATHER_TIMEOUT_MS,
      DIRECT_SRFLX_GRACE_MS,
    ]);

    timers.fireAt(DIRECT_SRFLX_GRACE_MS);
    expect(await offering).toContain('typ srflx');
  });

  /**
   * An answerer's stack starts gathering inside `setRemoteDescription`, so a
   * srflx can be gathered — its `icecandidate` heard by no one — before this end
   * has a description or a wait. The wait finds it in the description it begins
   * with, once `setLocalDescription` has resolved.
   */
  it('starts the grace with the wait for a server-reflexive candidate gathered before it', async () => {
    const { offerer, answerer, clientPeer, burrowPeer, timers } = pair({ gathering: 'pending' });
    offerer.completeGathering();
    const offer = await clientPeer.offer();

    answerer.gatherWithRemoteOffer('srflx', { form: 'polyfill' });
    const answering = burrowPeer.answer(offer!);
    await flushMicrotasks();
    expect(liveDelays(timers)).toEqual([
      DIRECT_SETUP_TIMEOUT_MS,
      DIRECT_ANSWER_TIMEOUT_MS,
      DIRECT_GATHER_TIMEOUT_MS,
      DIRECT_SRFLX_GRACE_MS,
    ]);
    timers.fireAt(DIRECT_SRFLX_GRACE_MS);

    expect(await answering).toContain('typ srflx');
    expect(liveDelays(timers)).toEqual([DIRECT_SETUP_TIMEOUT_MS, DIRECT_ANSWER_TIMEOUT_MS]);
  });

  it('sends as soon as gathering completes, without waiting out the grace or the deadline', async () => {
    const { network, offerer, clientPeer, timers } = pair({ gathering: 'pending' });

    const offering = clientPeer.offer();
    await flushMicrotasks();
    offerer.gatherCandidate('srflx');
    expect(liveDelays(timers)).toContain(DIRECT_SRFLX_GRACE_MS);
    network.completeGathering();

    expect(await offering).toContain('m=application');
    // Both gathering deadlines are cancelled; only the setup one is still armed.
    expect(liveDelays(timers)).toEqual([DIRECT_SETUP_TIMEOUT_MS]);
  });

  it('abandons a channel that never opens, and closes the connection', async () => {
    const { clientPeer, burrowPeer, client, timers } = pair({ opening: 'never' });

    const offer = await clientPeer.offer();
    await clientPeer.acceptAnswer((await burrowPeer.answer(offer!))!);
    await flushMicrotasks();
    expect(client.opens).toBe(0);

    timers.fireAt(DIRECT_SETUP_TIMEOUT_MS);

    expect(client.closes).toEqual(['the direct channel did not open in time']);
    expect(clientPeer.isOpen).toBe(false);
    // And nothing may be sent on it afterwards: the channel is gone, and a
    // closed peer reports nothing twice.
    clientPeer.send(Uint8Array.of(1));
    expect(client.closes).toEqual(['the direct channel did not open in time']);
  });

  it('reports a channel that dies under a live session, at both ends', async () => {
    const { network, clientPeer, burrowPeer, client, burrow } = pair();
    const offer = await clientPeer.offer();
    await clientPeer.acceptAnswer((await burrowPeer.answer(offer!))!);
    await flushMicrotasks();

    network.dropChannels();

    expect(client.closes).toEqual(['the direct channel closed']);
    expect(burrow.closes).toEqual(['the direct channel closed']);
  });

  it('reports a channel message this protocol has no reading for', async () => {
    const { network, clientPeer, burrowPeer, client } = pair();
    const offer = await clientPeer.offer();
    await clientPeer.acceptAnswer((await burrowPeer.answer(offer!))!);
    await flushMicrotasks();

    network.offererChannel!.receiveRaw('a text frame');
    // Bounded before it reaches a cipher, exactly as a relay ciphertext is.
    network.offererChannel!.receiveRaw(new ArrayBuffer(NOISE_MAX_MESSAGE_LENGTH + 1));

    expect(client.violations).toEqual([
      'a direct channel message was not binary',
      'a direct channel frame exceeds one Noise message',
    ]);
    // A violation is the endpoint's to act on: the channel is not torn down here.
    expect(client.frames).toEqual([]);
  });

  it('skips a description too large to travel inside the session', async () => {
    const offering = pair({ oversize: 'offer' });
    expect(await offering.clientPeer.offer()).toBeNull();

    const answering = pair({ oversize: 'answer' });
    const offer = await answering.clientPeer.offer();
    expect(await answering.burrowPeer.answer(offer!)).toBeNull();
  });

  it('answers null rather than throwing when the negotiation fails', async () => {
    const timers = fakeTimers();
    const record = handlers();
    const peer = new FakeDirectNetwork().createOfferer();
    vi.spyOn(peer, 'createOffer').mockRejectedValue(new Error('no transport'));
    const wrapper = new DirectPeer({ peer, handlers: record, setTimer: timers.setTimer });

    expect(await wrapper.offer()).toBeNull();
    expect(record.closes).toHaveLength(1);
    expect(peer.closed).toBe(true);
  });

  /**
   * `RTCPeerConnection.close()` fires no `icegatheringstatechange`, so nothing
   * but `close()` can ever settle this wait — and until it does, the suspended
   * negotiation holds the endpoint and its session alive behind a timer that is
   * not `unref`ed.
   */
  it('cancels the gathering deadline when it is closed mid-negotiation', async () => {
    const { offerer, clientPeer, timers } = pair({ gathering: 'pending' });

    const offering = clientPeer.offer();
    await flushMicrotasks();
    offerer.gatherCandidate('srflx');
    expect(liveDelays(timers)).toEqual([
      DIRECT_SETUP_TIMEOUT_MS,
      DIRECT_GATHER_TIMEOUT_MS,
      DIRECT_SRFLX_GRACE_MS,
    ]);

    clientPeer.close();

    expect(await offering).toBeNull();
    expect(timers.live).toEqual([]);
  });

  it('closes idempotently, reporting nothing', () => {
    const { clientPeer, client } = pair();
    clientPeer.close();
    clientPeer.close();
    expect(client.closes).toEqual([]);
  });

  describe('what a sender may hold', () => {
    it('queues past the high-water mark and drains when the channel catches up', async () => {
      const { network, clientPeer, burrow } = await connected();
      const channel = network.offererChannel!;
      channel.bufferedAmount = DIRECT_BUFFER_HIGH;

      clientPeer.send(Uint8Array.of(1));
      clientPeer.send(Uint8Array.of(2));
      await flushMicrotasks();
      // Held here rather than handed to a buffer that would refuse them.
      expect(channel.sent).toEqual([]);
      expect(burrow.frames).toEqual([]);

      channel.drained();
      await flushMicrotasks();

      expect(burrow.frames).toEqual([Uint8Array.of(1), Uint8Array.of(2)]);
    });

    it('holds a later frame behind an earlier one, whatever the buffer says', async () => {
      const { network, clientPeer } = await connected();
      const channel = network.offererChannel!;
      channel.bufferedAmount = DIRECT_BUFFER_HIGH;
      clientPeer.send(Uint8Array.of(1));

      // The buffer drains without the event that says so: a frame that jumped
      // the queue here would reach the peer ahead of the one before it.
      channel.bufferedAmount = 0;
      clientPeer.send(Uint8Array.of(2));
      await flushMicrotasks();

      expect(channel.sent).toEqual([]);
    });

    it('reports the path gone when a send would outrun the queue, in bytes', async () => {
      const { network, clientPeer, client } = await connected();
      network.offererChannel!.bufferedAmount = DIRECT_BUFFER_HIGH;
      const frame = new Uint8Array(NOISE_MAX_MESSAGE_LENGTH);

      let held = 0;
      while (client.closes.length === 0 && held <= MAX_DIRECT_PENDING_FRAMES) {
        clientPeer.send(frame);
        held += 1;
      }

      // **Our bound, not the peer's stack**: an operator reading a burrow-loss
      // log has only the reason to tell those two apart.
      expect(client.closes).toEqual(['the direct path outran what a sender can hold in order']);
      // Bytes bind first: the frame cap is far above what this many reaches.
      expect((held - 1) * frame.length).toBeLessThanOrEqual(MAX_DIRECT_PENDING_BYTES);
      expect(held * frame.length).toBeGreaterThan(MAX_DIRECT_PENDING_BYTES);
    });

    it('says when what it sent has left: its queue and the channel’s buffer both empty', async () => {
      const { network, clientPeer, burrow } = await connected();
      const channel = network.offererChannel!;
      const flushed = vi.fn();
      clientPeer.afterFlush(flushed);
      // Nothing waiting: at once.
      expect(flushed).toHaveBeenCalledTimes(1);

      channel.bufferedAmount = DIRECT_BUFFER_HIGH;
      clientPeer.send(Uint8Array.of(1));
      const later = vi.fn();
      clientPeer.afterFlush(later);
      expect(later).not.toHaveBeenCalled();
      // Woken only at empty from here, not at the low-water mark.
      expect(channel.bufferedAmountLowThreshold).toBe(0);

      // The buffer empties and the queued frame goes out — into the buffer,
      // which a real channel then reports holding: not yet.
      const send = channel.send.bind(channel);
      channel.send = (data) => {
        send(data);
        channel.bufferedAmount = 1;
      };
      channel.drained();
      expect(channel.sent).toEqual([Uint8Array.of(1)]);
      expect(later).not.toHaveBeenCalled();

      channel.drained();
      expect(later).toHaveBeenCalledTimes(1);
      await flushMicrotasks();
      expect(burrow.frames).toEqual([Uint8Array.of(1)]);
    });

    it('stops waiting for a flush when the channel goes', async () => {
      const { network, clientPeer } = await connected();
      network.offererChannel!.bufferedAmount = DIRECT_BUFFER_HIGH;
      clientPeer.send(Uint8Array.of(1));
      const flushed = vi.fn();
      clientPeer.afterFlush(flushed);

      clientPeer.close();
      expect(flushed).toHaveBeenCalledTimes(1);
    });

    it('reports the channel gone when a queued frame will not go out', async () => {
      const { network, clientPeer, client } = await connected();
      const channel = network.offererChannel!;
      channel.bufferedAmount = DIRECT_BUFFER_HIGH;
      clientPeer.send(Uint8Array.of(1));

      // Closed under the queue: the drain finds a channel that will not take it.
      channel.readyState = 'closed';
      channel.drained();

      expect(client.closes).toEqual(['the direct channel refused a message']);
    });
  });

  describe('what the channel has to be', () => {
    it.each(['unordered', 'lossy', 'expiring', 'mislabeled'] as const)(
      'refuses a %s channel, before anything rides it',
      async (defect) => {
        const { clientPeer, client } = pair({ channel: defect });

        expect(await clientPeer.offer()).toBeNull();

        expect(client.opens).toBe(0);
        expect(client.closes).toEqual([
          'the direct channel is not the reliable ordered one this session opens',
        ]);
      },
    );

    it('refuses one the peer created, which is where the check can fail', async () => {
      // The offerer only re-reads the channel it asked for; the answerer is
      // handed one by a peer it has no reason to trust to have asked for the
      // same thing.
      const { clientPeer, burrowPeer, burrow } = pair({
        channel: 'unordered',
        channelSide: 'answerer',
      });

      const offer = await clientPeer.offer();
      expect(await burrowPeer.answer(offer!)).toBeNull();

      expect(burrow.closes).toEqual([
        'the direct channel is not the reliable ordered one this session opens',
      ]);
    });

    it('abandons a channel that cannot carry one Noise message', async () => {
      const { clientPeer, client } = await connected({ maxMessageSize: 16_384 });

      expect(client.opens).toBe(0);
      expect(client.closes).toEqual(['the direct channel carries only 16384 bytes per message']);
      expect(clientPeer.isOpen).toBe(false);
    });

    it('opens where the association reports no limit to check', async () => {
      const { clientPeer, client } = await connected({ maxMessageSize: null });

      expect(client.opens).toBe(1);
      expect(clientPeer.isOpen).toBe(true);
    });
  });

  describe('the connection under the channel', () => {
    it('ends the attempt at once when the connection fails', async () => {
      const { offerer, clientPeer, client } = await connected();

      offerer.setConnectionState('failed');

      expect(client.closes).toEqual(['the direct connection failed']);
      expect(clientPeer.isOpen).toBe(false);
    });

    it('waits a disconnected connection out, then gives up on one that stays down', async () => {
      const { offerer, client, timers } = await connected();

      offerer.setConnectionState('disconnected');
      // A gap ICE often recovers from: nothing is reported while it may.
      expect(client.closes).toEqual([]);

      timers.fireAt(DIRECT_DISCONNECTED_GRACE_MS);

      expect(client.closes).toEqual(['the direct connection stayed disconnected']);
    });

    it('keeps a connection that comes back inside the grace', async () => {
      const { offerer, clientPeer, client, timers } = await connected();

      offerer.setConnectionState('disconnected');
      offerer.setConnectionState('connected');

      expect(timers.live).toEqual([]);
      expect(client.closes).toEqual([]);
      expect(clientPeer.isOpen).toBe(true);
    });
  });

  describe('the path policy', () => {
    it('checks the selected pair before reporting the open', async () => {
      const policy = lanOnlyPolicy();
      const { burrowPeer, burrow } = await connected({}, policy);

      expect(policy.asked).toEqual([FAKE_LAN_PAIR]);
      expect(burrow.opens).toBe(1);
      expect(burrowPeer.isOpen).toBe(true);
    });

    it('refuses a path it does not allow as a violation, before anything rides it', async () => {
      const run = await connected({ selectedPair: OFF_LAN }, lanOnlyPolicy());

      expect(run.burrow.opens).toBe(0);
      expect(run.burrow.refusals).toEqual(['off the LAN']);
      expect(run.burrow.violations).toEqual([]);
      expect(run.burrow.closes).toEqual([]);
      expect(run.answerer.closed).toBe(true);
      expect(run.burrowPeer.isOpen).toBe(false);
    });

    it('refuses where the stack reports no pair', async () => {
      const policy = lanOnlyPolicy();
      const run = await connected({ selectedPair: null }, policy);

      expect(policy.asked).toEqual([null]);
      expect(run.burrow.refusals).toEqual(['off the LAN']);
    });

    it('checks again when the connection comes back connected, on whatever pair it has', async () => {
      const { answerer, burrow } = await connected({}, lanOnlyPolicy());

      answerer.setConnectionState('disconnected');
      answerer.selectedPair = { local: '10.0.0.2', remote: '192.168.1.3' };
      answerer.setConnectionState('connected');

      expect(burrow.refusals).toEqual(['off the LAN']);
      expect(answerer.closed).toBe(true);
    });

    it('checks again when ICE moves an open connection onto another pair', async () => {
      const { answerer, burrow } = await connected({}, lanOnlyPolicy());
      answerer.setConnectionState('connected');
      expect(burrow.refusals).toEqual([]);

      answerer.reselect({ local: '192.168.1.2', remote: '10.0.0.3' });

      expect(burrow.refusals).toEqual(['off the LAN']);
    });

    it('re-reads the pair while open, since ICE can move it with no event at all', async () => {
      const { answerer, burrow, timers } = await connected({}, lanOnlyPolicy());
      answerer.setConnectionState('connected');
      timers.fireAt(DIRECT_PATH_RECHECK_MS);
      expect(burrow.refusals).toEqual([]);

      // A later nomination the stack reports to no one.
      answerer.selectedPair = { local: '192.168.1.2', remote: '10.0.0.3' };
      timers.fireAt(DIRECT_PATH_RECHECK_MS);

      expect(burrow.refusals).toEqual(['off the LAN']);
      expect(answerer.closed).toBe(true);
      expect(liveDelays(timers)).not.toContain(DIRECT_PATH_RECHECK_MS);
    });

    it('leaves a reading with no pair, once open, to the connection’s own state', async () => {
      const { answerer, burrow, timers } = await connected({}, lanOnlyPolicy());
      answerer.setConnectionState('connected');
      answerer.reselect(null);
      timers.fireAt(DIRECT_PATH_RECHECK_MS);
      expect(burrow.refusals).toEqual([]);

      answerer.setConnectionState('failed');
      expect(burrow.closes).toEqual(['the direct connection failed']);
      expect(burrow.refusals).toEqual([]);
    });

    it('arms no re-read for a peer no policy holds', async () => {
      const { timers } = await connected();
      expect(liveDelays(timers)).not.toContain(DIRECT_PATH_RECHECK_MS);
    });

    it('leaves a connection on its way down to the connection’s own rules', async () => {
      const { answerer, burrow, timers } = await connected({}, lanOnlyPolicy());
      answerer.setConnectionState('disconnected');
      // ICE reselecting under a gap is not a path to check: the grace decides.
      answerer.reselect(null);
      expect(burrow.refusals).toEqual([]);

      timers.fireAt(DIRECT_DISCONNECTED_GRACE_MS);
      expect(burrow.closes).toEqual(['the direct connection stayed disconnected']);
      expect(burrow.refusals).toEqual([]);
    });

    it('checks a frame that arrives before the open, which no stack should deliver', async () => {
      const run = pair({ opening: 'manual', selectedPair: OFF_LAN }, lanOnlyPolicy());
      const offer = await run.clientPeer.offer();
      await run.clientPeer.acceptAnswer((await run.burrowPeer.answer(offer!))!);

      run.network.answererChannel!.receiveRaw(new ArrayBuffer(8));

      expect(run.burrow.frames).toEqual([]);
      expect(run.burrow.refusals).toEqual(['off the LAN']);
    });

    it('names a refused pair’s remote end as observed, over what the offer reported', async () => {
      const offered: string[] = [];
      const run = await connected(
        { selectedPair: OFF_LAN },
        lanOnlyPolicy({
          reportedAddress: (sdp) => {
            offered.push(sdp);
            return '203.0.113.7';
          },
          // Stripped of everything: what is reported is read before this.
          acceptRemote: () => 'v=0\r\n',
        }),
      );
      expect(offered).toHaveLength(1);
      expect(offered[0]).toContain(`a=candidate:1 1 udp 2130706431 ${FAKE_LAN_PAIR.remote}`);
      expect(run.burrowPeer.refusedEnd).toEqual({ end: 'remote', address: { address: OFF_LAN.remote, source: 'observed' } });
    });

    it('names this end, and never the phone, where the policy refused this machine’s end of the pair', async () => {
      const run = await connected(
        { selectedPair: { local: '::ffff:10.0.0.2', remote: '10.0.0.3' } },
        lanOnlyPolicy({ reportedAddress: () => '203.0.113.7' }),
      );
      expect(run.burrow.refusals).toEqual(['off the LAN']);
      expect(run.burrowPeer.refusedEnd).toEqual({ end: 'local', address: '10.0.0.2' });
    });

    it('names this end with no address where none of its candidates is on an allowed network', async () => {
      const run = pair({}, lanOnlyPolicy({ describe: () => null, reportedAddress: () => '203.0.113.7' }));
      expect(await run.burrowPeer.answer((await run.clientPeer.offer())!)).toBeNull();
      expect(run.burrowPeer.refusedEnd).toEqual({ end: 'local', address: null });
    });

    it('names what the offer reported where no pair was reported, and neither end without it', async () => {
      const reported = await connected({ selectedPair: null }, lanOnlyPolicy({ reportedAddress: () => '203.0.113.7' }));
      expect(reported.burrow.refusals).toEqual(['off the LAN']);
      expect(reported.burrowPeer.refusedEnd).toEqual({
        end: 'remote',
        address: { address: '203.0.113.7', source: 'reported' },
      });

      const unnamed = await connected({ selectedPair: null }, lanOnlyPolicy());
      expect(unnamed.burrowPeer.refusedEnd).toBeNull();
    });

    it('names what the offer reported where no pair was refused, and nothing without a policy', async () => {
      const policy = lanOnlyPolicy({ reportedAddress: () => '203.0.113.7' });
      // A public address in the offer decides nothing: the allowed pair carries
      // the session, and is no evidence of where a refused phone was.
      const allowed = await connected({}, policy);
      expect(allowed.burrow.opens).toBe(1);
      expect(allowed.burrow.refusals).toEqual([]);
      expect(allowed.burrowPeer.refusedEnd).toEqual({
        end: 'remote',
        address: { address: '203.0.113.7', source: 'reported' },
      });

      const unheld = await connected({ selectedPair: OFF_LAN });
      expect(unheld.burrowPeer.refusedEnd).toBeNull();
    });

    it('names only an IP literal, an IPv4-mapped one as its IPv4 half', async () => {
      const mapped = await connected(
        { selectedPair: { local: '192.168.1.2', remote: '::ffff:172.58.12.9' } },
        lanOnlyPolicy({ reportedAddress: () => '203.0.113.7' }),
      );
      expect(mapped.burrowPeer.refusedEnd).toEqual({
        end: 'remote',
        address: { address: '172.58.12.9', source: 'observed' },
      });

      const named = await connected(
        { selectedPair: { local: '192.168.1.2', remote: '0b1c5f3a-1d2e.local' } },
        lanOnlyPolicy({ reportedAddress: () => 'phone.local' }),
      );
      expect(named.burrow.refusals).toEqual(['off the LAN']);
      expect(named.burrowPeer.refusedEnd).toEqual({ end: 'remote', address: null });
    });

    it('applies the peer’s description as the policy accepts it', async () => {
      const run = pair({}, lanOnlyPolicy({ acceptRemote: (sdp) => `${sdp}a=accepted\r\n` }));
      const offer = await run.clientPeer.offer();
      await run.burrowPeer.answer(offer!);
      expect(run.answerer.remoteDescription).toEqual({ type: 'offer', sdp: `${offer}a=accepted\r\n` });
    });

    it('sends its description as the policy describes it, and refuses when nothing is left', async () => {
      const stripped = pair({}, lanOnlyPolicy({ describe: (sdp) => `${sdp}a=described\r\n` }));
      const offer = await stripped.clientPeer.offer();
      expect(await stripped.burrowPeer.answer(offer!)).toMatch(/a=described\r\n$/);

      const empty = pair({}, lanOnlyPolicy({ describe: () => null }));
      expect(await empty.burrowPeer.answer((await empty.clientPeer.offer())!)).toBeNull();
      expect(empty.burrow.refusals).toEqual(['no candidate of this end is on an allowed network']);
      expect(empty.answerer.closed).toBe(true);
    });
  });
});
