/**
 * The peer wrapper over the linked fake pair (`docs/specs/remote-api.md` ->
 * Transport -> "Direct path"): one negotiation, one channel, and the four ways
 * it can end. The end-to-end cases that drive it inside a real session are in
 * `../client/pocket-client.test.ts` and `../burrow/burrow-runtime.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DIRECT_BUFFER_HIGH,
  DIRECT_CHANNEL_LABEL,
  DIRECT_DISCONNECTED_GRACE_MS,
  DIRECT_GATHER_TIMEOUT_MS,
  DIRECT_SETUP_TIMEOUT_MS,
  MAX_DIRECT_OUTBOUND_BYTES,
  MAX_DIRECT_OUTBOUND_FRAMES,
  NOISE_MAX_MESSAGE_LENGTH,
} from 'remote-lib-common';

import { DirectPeer, type DirectPeerHandlers } from './direct-peer';
import { FakeDirectNetwork, flushMicrotasks, type FakeDirectNetworkOptions } from './test-fake-peer';
import { fakeTimers } from '../test-timers';

function handlers(): DirectPeerHandlers & {
  frames: Uint8Array[];
  opens: number;
  closes: string[];
  violations: string[];
} {
  const record = {
    frames: [] as Uint8Array[],
    opens: 0,
    closes: [] as string[],
    violations: [] as string[],
    onOpen: () => void (record.opens += 1),
    onFrame: (frame: Uint8Array) => void record.frames.push(frame),
    onClosed: (reason: string) => void record.closes.push(reason),
    onViolation: (reason: string) => void record.violations.push(reason),
  };
  return record;
}

/** Both ends of one negotiation, sharing a clock the test drives. */
function pair(options: FakeDirectNetworkOptions = {}) {
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
    burrowPeer: new DirectPeer({ peer: answerer, handlers: burrow, setTimer: timers.setTimer }),
  };
}

/** One negotiated pair with both channels open, as most cases start. */
async function connected(options: FakeDirectNetworkOptions = {}) {
  const run = pair(options);
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

  it('sends the description it has when gathering never completes', async () => {
    const { clientPeer, timers } = pair({ gathering: 'pending' });

    const offering = clientPeer.offer();
    let settled = false;
    void offering.then(() => (settled = true));
    await flushMicrotasks();
    // Nothing to send yet: there is no trickle path, so the SDP waits.
    expect(settled).toBe(false);

    timers.fireAt(DIRECT_GATHER_TIMEOUT_MS);
    expect(await offering).toContain('m=application');
  });

  it('sends as soon as gathering completes, without waiting out the deadline', async () => {
    const { network, clientPeer, timers } = pair({ gathering: 'pending' });

    const offering = clientPeer.offer();
    await flushMicrotasks();
    network.completeGathering();

    expect(await offering).toContain('m=application');
    // The gathering deadline is cancelled; only the setup one is still armed.
    expect(timers.live.map((timer) => timer.delayMs)).toEqual([DIRECT_SETUP_TIMEOUT_MS]);
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
    const { clientPeer, timers } = pair({ gathering: 'pending' });

    const offering = clientPeer.offer();
    await flushMicrotasks();
    expect(timers.live.map((timer) => timer.delayMs)).toEqual([
      DIRECT_SETUP_TIMEOUT_MS,
      DIRECT_GATHER_TIMEOUT_MS,
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
      while (client.closes.length === 0 && held <= MAX_DIRECT_OUTBOUND_FRAMES) {
        clientPeer.send(frame);
        held += 1;
      }

      // **Our bound, not the peer's stack**: an operator reading a burrow-loss
      // log has only the reason to tell those two apart.
      expect(client.closes).toEqual(['the direct path outran what a sender can hold in order']);
      // Bytes bind first: the frame cap is far above what this many reaches.
      expect((held - 1) * frame.length).toBeLessThanOrEqual(MAX_DIRECT_OUTBOUND_BYTES);
      expect(held * frame.length).toBeGreaterThan(MAX_DIRECT_OUTBOUND_BYTES);
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
});
