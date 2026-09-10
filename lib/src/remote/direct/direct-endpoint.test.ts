/**
 * The cutover policy both ends run (`docs/specs/remote-api.md` -> Transport ->
 * "Direct path"), driven as two endpoints over the linked fake pair.
 *
 * This is where the rules live now: what an attempt may do, what each signal
 * means to each role, and what a channel event costs the session. The suites in
 * `../client/pocket-client.test.ts` and `../burrow/burrow-runtime.test.ts` keep
 * only the cases that prove the wiring — that the signals really are control
 * messages on a real session, and that a loss really disposes what the runtime
 * holds.
 *
 * Signals ride a stand-in for the relay here: they are plain objects, delivered
 * to the far endpoint, with one direction holdable so a case can reproduce the
 * race the holding queue exists for.
 */

import { describe, expect, it } from 'vitest';
import {
  DIRECT_ANSWER_TIMEOUT_MS,
  DIRECT_GATHER_TIMEOUT_MS,
  DIRECT_HANDOFF_TIMEOUT_MS,
  DIRECT_SETUP_TIMEOUT_MS,
  MAX_DIRECT_PENDING_FRAMES,
  toBase64Url,
  type DirectPath,
  type DirectRelayCause,
  type DirectSignalV1,
} from 'remote-lib-common';

import { DirectEndpoint } from './direct-endpoint';
import { FakeDirectNetwork, type FakeDirectNetworkOptions, type FakePeer } from './test-fake-peer';
import { fakeTimers } from '../test-timers';

interface Side {
  endpoint: DirectEndpoint;
  /** Every peer connection this side's factory built. */
  readonly peers: FakePeer[];
  /** Every ciphertext this side decrypted, in the order it did. */
  readonly received: Uint8Array[];
  /** Every reason this side's session was declared unrecoverable. */
  readonly fatals: string[];
  /** Every path change announced. */
  readonly paths: DirectPath[];
  /** Every cause announced beside a path; see `DirectEndpoint.relayCause`. */
  readonly causes: Array<DirectRelayCause | null>;
  /** Every signal this side put on the relay. */
  readonly sent: DirectSignalV1[];
  /** What `isCurrent()` answers; a promotion or teardown flips it. */
  live: boolean;
  /** Whether the session can still encrypt a signal. */
  sendable: boolean;
  /** Hold this side's outbound signals instead of delivering them. */
  hold(): void;
  /** Deliver everything held, in order. */
  release(): void;
}

interface Options extends FakeDirectNetworkOptions {
  /** Give the offerer no peer factory, as a browser without WebRTC has. */
  offererHasPeer?: boolean;
  /** Give the answerer none, as the VS Code host has. */
  answererHasPeer?: boolean;
}

/** Both endpoints of one session, linked by a relay a case can hold. */
function pair(options: Options = {}) {
  const { offererHasPeer = true, answererHasPeer = true, ...network } = options;
  const fake = new FakeDirectNetwork(network);
  const timers = fakeTimers();
  const sides = new Map<'offerer' | 'answerer', Side>();

  const build = (role: 'offerer' | 'answerer', hasPeer: boolean): Side => {
    const peers: FakePeer[] = [];
    const queued: DirectSignalV1[] = [];
    const side: Side = {
      peers,
      received: [],
      fatals: [],
      paths: [],
      causes: [],
      sent: [],
      live: true,
      sendable: true,
      hold: () => void (holding = true),
      release: () => {
        holding = false;
        for (const signal of queued.splice(0)) deliver(signal);
      },
      endpoint: undefined as unknown as DirectEndpoint,
    };
    let holding = false;
    const deliver = (signal: DirectSignalV1): void => {
      sides.get(role === 'offerer' ? 'answerer' : 'offerer')?.endpoint.onSignal({ ...signal });
    };
    side.endpoint = new DirectEndpoint(role, {
      createPeer: hasPeer
        ? () => {
            const peer = role === 'offerer' ? fake.createOfferer() : fake.createAnswerer();
            peers.push(peer);
            return peer;
          }
        : null,
      sendSignal: (signal) => {
        if (!side.sendable) return false;
        side.sent.push(signal);
        if (holding) queued.push(signal);
        else deliver(signal);
        return true;
      },
      receive: (ciphertext) => {
        side.received.push(ciphertext);
        // Signals ride the stand-in relay here rather than a real session, so
        // nothing a frame decrypts to is a control message.
        return { kind: 'keepalive' } as const;
      },
      fatal: (reason) => void side.fatals.push(reason),
      isCurrent: () => side.live,
      onTransportChanged: (path, cause) => {
        side.paths.push(path);
        side.causes.push(cause);
      },
      setTimer: timers.setTimer,
    });
    sides.set(role, side);
    return side;
  };

  const offerer = build('offerer', offererHasPeer);
  const answerer = build('answerer', answererHasPeer);
  return { fake, timers, offerer, answerer };
}

/** Let the fake network's queued microtasks run. */
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Offer, answer, and let the channel open at both ends. */
async function cutover(run: ReturnType<typeof pair>): Promise<void> {
  await run.offerer.endpoint.offer();
  await flushMicrotasks();
  await flushMicrotasks();
}

const frame = (n: number, size = 4) => new Uint8Array(size).fill(n);

describe('DirectEndpoint', () => {
  it('offers, answers, and switches both directions onto the channel', async () => {
    const run = pair();

    await cutover(run);

    expect(run.offerer.sent.map((s) => s.t)).toEqual(['direct-offer', 'direct-switch']);
    expect(run.answerer.sent.map((s) => s.t)).toEqual(['direct-answer', 'direct-switch']);
    expect(run.offerer.endpoint.path).toBe('direct');
    expect(run.answerer.endpoint.path).toBe('direct');
    // Announced once, and only once both directions had left the relay.
    expect(run.offerer.paths).toEqual(['direct']);
    expect(run.offerer.fatals).toEqual([]);
    expect(run.answerer.fatals).toEqual([]);
  });

  it('spends the session’s one attempt, whichever end asks twice', async () => {
    const run = pair();

    await cutover(run);
    const offer = run.offerer.sent[0]!;
    if (offer.t !== 'direct-offer') throw new Error(`expected an offer, got ${offer.t}`);
    await run.offerer.endpoint.offer();
    run.answerer.endpoint.onSignal({ ...offer });

    // A second offer allocates nothing and is not answered — not even with a
    // decline — at either end.
    expect(run.offerer.peers).toHaveLength(1);
    expect(run.answerer.peers).toHaveLength(1);
    expect(run.offerer.sent.map((s) => s.t)).toEqual(['direct-offer', 'direct-switch']);
    expect(run.answerer.sent.map((s) => s.t)).toEqual(['direct-answer', 'direct-switch']);
  });

  it('declines an offer it has no way to answer, and stays relayed', async () => {
    const run = pair({ answererHasPeer: false });

    await run.offerer.endpoint.offer();
    await flushMicrotasks();

    expect(run.answerer.sent.map((s) => s.t)).toEqual(['direct-decline']);
    // The decline abandons the offerer's attempt: its peer is closed and the
    // session is exactly as relayed as it was.
    expect(run.offerer.peers[0]!.closed).toBe(true);
    expect(run.offerer.endpoint.path).toBe('relay');
    expect(run.offerer.fatals).toEqual([]);
  });

  it('never offers from a runtime with no peer connection', async () => {
    const run = pair({ offererHasPeer: false });

    await run.offerer.endpoint.offer();
    await flushMicrotasks();

    expect(run.offerer.sent).toEqual([]);
    expect(run.answerer.peers).toEqual([]);
    // And the attempt is spent: a signal arriving later cannot start one.
    expect(run.offerer.endpoint.path).toBe('relay');
  });

  it('skips a description too large to travel inside the session', async () => {
    const offering = pair({ oversize: 'offer' });
    await offering.offerer.endpoint.offer();
    expect(offering.offerer.sent).toEqual([]);

    const answering = pair({ oversize: 'answer' });
    await answering.offerer.endpoint.offer();
    await flushMicrotasks();
    expect(answering.answerer.sent.map((s) => s.t)).toEqual(['direct-decline']);
  });

  it('declines rather than leaving the offerer to wait, when its channel is refused', async () => {
    const run = pair({ channel: 'unordered', channelSide: 'answerer' });

    await run.offerer.endpoint.offer();
    await flushMicrotasks();

    // The refusal reports from inside `answer()`, before there is any
    // description to send — the offerer still has to hear about it.
    expect(run.answerer.sent.map((s) => s.t)).toEqual(['direct-decline']);
    // And the answerer's setup deadline, armed inside `answer()`, went with it.
    expect(run.timers.live).toEqual([]);
  });

  /**
   * A decline is a message on the relay, so it only means anything while there
   * is still a relay to send it on. A peer that put its own `direct-switch`
   * across before this end had answered has already taken the session with it —
   * `DirectCutover` accepts that switch while the attempt is merely
   * `attempting` — and a decline sent after would reach a Client that reads it
   * as a refusal rather than as the channel that never opened.
   */
  it('never declines onto a session its own give-up has already ended', async () => {
    // Gathering is held open so the answerer is still suspended inside
    // `answer()` when the switch lands.
    const run = pair({ oversize: 'answer', gathering: 'pending' });
    const offering = run.offerer.endpoint.offer();
    await flushMicrotasks();
    run.timers.fireAt(DIRECT_GATHER_TIMEOUT_MS);
    await offering;
    await flushMicrotasks();

    // The peer switches before it has been answered, and only then does this
    // end find it has no description it can send.
    run.answerer.endpoint.onSignal({ v: 1, t: 'direct-switch' });
    run.timers.fireAt(DIRECT_GATHER_TIMEOUT_MS);
    await flushMicrotasks();

    expect(run.answerer.sent.map((s) => s.t)).toEqual([]);
    expect(run.answerer.fatals).toHaveLength(1);
  });

  it('abandons the attempt when the session cannot carry a signal', async () => {
    const run = pair();
    run.offerer.sendable = false;

    await run.offerer.endpoint.offer();
    await flushMicrotasks();

    expect(run.offerer.peers[0]!.closed).toBe(true);
    expect(run.answerer.peers).toEqual([]);
    expect(run.offerer.fatals).toEqual([]);
  });

  it('closes a peer whose session was replaced while it described itself', async () => {
    const run = pair();
    // Flipped while `offer()` is awaiting its description, which is exactly what
    // a replacement promotion or a teardown does to the session under it.
    const offering = run.offerer.endpoint.offer();
    run.offerer.live = false;
    await offering;

    expect(run.offerer.peers[0]!.closed).toBe(true);
    expect(run.offerer.sent).toEqual([]);
  });

  it('ignores every signal that is the other role’s to send, and every unknown shape', async () => {
    const run = pair();
    await cutover(run);
    const offererSent = run.offerer.sent.length;

    // The compatibility rule the whole staging rests on: a control shape this
    // peer does not know leaves the session up.
    run.offerer.endpoint.onSignal({ v: 2, t: 'direct-decline' });
    run.offerer.endpoint.onSignal({ t: 'something-else' });
    run.offerer.endpoint.onSignal({ v: 1, t: 'direct-offer', sdp: 'v=0\r\n' });
    run.answerer.endpoint.onSignal({ v: 1, t: 'direct-answer', sdp: 'v=0\r\n' });
    run.answerer.endpoint.onSignal({ v: 1, t: 'direct-decline' });

    expect(run.offerer.sent).toHaveLength(offererSent);
    expect(run.offerer.fatals).toEqual([]);
    expect(run.answerer.fatals).toEqual([]);
  });

  it('stays relayed when the channel never opens', async () => {
    const run = pair({ opening: 'never' });
    await cutover(run);

    run.timers.fireAt(DIRECT_SETUP_TIMEOUT_MS);

    expect(run.offerer.peers[0]!.closed).toBe(true);
    expect(run.offerer.endpoint.path).toBe('relay');
    // Never switched, so this is an abandoned attempt rather than burrow loss.
    expect(run.offerer.fatals).toEqual([]);
    expect(run.offerer.endpoint.send(frame(1))).toBe(false);
  });

  it('ends the session when the channel dies after the switch', async () => {
    const run = pair();
    await cutover(run);

    run.fake.dropChannels();

    expect(run.offerer.fatals).toEqual(['the direct channel closed']);
    expect(run.answerer.fatals).toEqual(['the direct channel closed']);
  });

  it('ends the session on a channel message this protocol has no reading for', async () => {
    const run = pair();
    await cutover(run);

    run.fake.offererChannel!.receiveRaw('a text frame');

    expect(run.offerer.fatals).toEqual(['a direct channel message was not binary']);
  });

  it('ignores a channel violation once its session is no longer the live one', async () => {
    const run = pair();
    await cutover(run);
    // What a replacement promotion does to the session under an endpoint: the
    // channel is still there and still reporting, and none of it is this
    // session's business any more.
    run.offerer.live = false;

    run.fake.offererChannel!.receiveRaw('a text frame');

    expect(run.offerer.fatals).toEqual([]);
  });

  it('holds channel frames until the peer’s switch, then drains them in order', async () => {
    const run = pair({ opening: 'manual' });
    await cutover(run);

    // The race the queue exists for: the answerer's frames overtake the
    // `direct-switch` that precedes them on the relay.
    run.answerer.hold();
    run.fake.openChannels();
    expect(run.offerer.endpoint.path).toBe('relay');

    run.answerer.endpoint.send(frame(1));
    run.answerer.endpoint.send(frame(2));
    await flushMicrotasks();
    expect(run.offerer.received).toEqual([]);

    run.answerer.release();

    expect(run.offerer.received).toEqual([frame(1), frame(2)]);
    expect(run.offerer.endpoint.path).toBe('direct');
  });

  it('ends the session when held frames outrun the queue', async () => {
    const run = pair({ opening: 'manual' });
    await cutover(run);
    run.answerer.hold();
    run.fake.openChannels();

    for (let i = 0; i <= MAX_DIRECT_PENDING_FRAMES; i += 1) run.answerer.endpoint.send(frame(i));
    await flushMicrotasks();

    expect(run.offerer.fatals).toEqual(['the direct path outran what can be held in order']);
    expect(run.offerer.received).toEqual([]);
  });

  /**
   * The two deadlines are armed on different clocks — the offerer's at `offer()`
   * and the answerer's a relay hop later, at `answer()` — so a channel that
   * comes up near the end of the budget must not have the answerer opening,
   * switching, and landing its `direct-switch` on an offerer that has just
   * abandoned. Giving the answerer the shorter budget makes its channel closing
   * the event that reaches the offerer, and both ends abandon.
   */
  it('gives the answerer the deadline that fires first, so a slow channel only abandons', async () => {
    const run = pair({ opening: 'never' });
    await cutover(run);

    run.timers.fireAt(DIRECT_ANSWER_TIMEOUT_MS);
    await flushMicrotasks();

    expect(run.answerer.peers[0]!.closed).toBe(true);
    // The answerer's channel closing is what the offerer sees, while it is
    // still unswitched and can give the attempt up.
    expect(run.offerer.peers[0]!.closed).toBe(true);
    expect(run.offerer.fatals).toEqual([]);
    expect(run.answerer.fatals).toEqual([]);
    expect(run.offerer.endpoint.path).toBe('relay');
    expect(run.answerer.endpoint.path).toBe('relay');
    // And the offerer's own budget is gone with its peer, so nothing is left
    // armed to fire on a session that has moved on.
    expect(run.timers.live).toEqual([]);
  });

  /**
   * From its own switch this end sends only on the channel, so a peer that
   * never switches back leaves it talking into one nothing reads. Without a
   * deadline of its own the wait would end only when the held frames overran
   * their bound — a function of how chatty the session happens to be.
   */
  it('ends the session when the peer never follows onto the channel', async () => {
    const run = pair({ opening: 'manual' });
    await cutover(run);

    // The answerer's own `direct-switch` never leaves it, so this end is
    // outbound-direct with the relay still carrying the other half.
    run.answerer.hold();
    run.fake.openChannels();
    expect(run.offerer.endpoint.path).toBe('relay');
    expect(run.offerer.fatals).toEqual([]);

    run.timers.fireAt(DIRECT_HANDOFF_TIMEOUT_MS);

    expect(run.offerer.fatals).toEqual(['the peer did not follow onto the direct path']);
  });

  it('leaves nothing armed once the peer has followed', async () => {
    const run = pair();

    await cutover(run);

    // Both setup budgets are gone with the opens, and both handoff deadlines
    // with the switches that answered them.
    expect(run.timers.live).toEqual([]);
  });

  /**
   * **A closed set, never the failure text.** The strings an attempt gives up
   * with include a runtime's own exception message; what the peer is told is
   * which of the three answers a person can act on it was.
   */
  describe('why a session stayed relayed', () => {
    it('says an attempt was never possible, beside the unchanged path', async () => {
      const run = pair({ offererHasPeer: false });

      await run.offerer.endpoint.offer();

      expect(run.offerer.endpoint.relayCause).toBe('unsupported');
      expect(run.offerer.causes).toEqual(['unsupported']);
      // The path never changed; the announcement is the cause alone.
      expect(run.offerer.paths).toEqual(['relay']);
    });

    it('tells the offerer it was declined, and the answerer why it declined', async () => {
      const run = pair({ answererHasPeer: false });

      await run.offerer.endpoint.offer();
      await flushMicrotasks();

      expect(run.offerer.endpoint.relayCause).toBe('declined');
      expect(run.answerer.endpoint.relayCause).toBe('unsupported');
    });

    it('calls a channel that never opened a failure, not a refusal', async () => {
      const run = pair({ opening: 'never' });
      await cutover(run);

      run.timers.fireAt(DIRECT_ANSWER_TIMEOUT_MS);
      await flushMicrotasks();

      expect(run.offerer.endpoint.relayCause).toBe('failed');
      expect(run.answerer.endpoint.relayCause).toBe('failed');
    });

    it('has nothing to say once the session is on the channel', async () => {
      const run = pair();

      await cutover(run);

      expect(run.offerer.endpoint.relayCause).toBeNull();
      expect(run.answerer.endpoint.relayCause).toBeNull();
      expect(run.offerer.causes).toEqual([null]);
    });
  });

  it('ends the session when the peer switches onto a channel this end abandoned', async () => {
    const run = pair({ opening: 'manual' });
    await cutover(run);

    run.timers.fireAt(DIRECT_SETUP_TIMEOUT_MS);
    expect(run.offerer.fatals).toEqual([]);
    // And only now does the peer's channel come up, so its switch lands on an
    // end that has already closed its own.
    run.offerer.endpoint.onSignal({ v: 1, t: 'direct-switch' });

    expect(run.offerer.fatals).toEqual([
      'the peer moved to a direct path this end had abandoned',
    ]);
  });

  it('refuses a relay transport frame once the peer has switched', async () => {
    const run = pair({ opening: 'manual' });
    await cutover(run);

    // Before the peer's switch the relay is still the path it sends on.
    run.offerer.endpoint.onRelayFrame(toBase64Url(frame(1)));
    expect(run.offerer.received).toEqual([frame(1)]);

    run.fake.openChannels();
    run.offerer.endpoint.onRelayFrame(toBase64Url(frame(2)));

    expect(run.offerer.fatals).toEqual(['a relay frame arrived after the direct switch']);
    // Refused before any decrypt: the ciphertext is never even looked at.
    expect(run.offerer.received).toEqual([frame(1)]);
  });

  /**
   * The wire guard bounds a `ct`'s alphabet and length, not its padding, so a
   * peer can put a well-shaped envelope on the relay whose ciphertext will not
   * decode. That is the session's failure, not an exception out of a socket
   * handler.
   */
  it('ends the session on a relay frame whose ciphertext will not decode', async () => {
    const run = pair({ opening: 'never' });
    await cutover(run);

    run.offerer.endpoint.onRelayFrame('AB');

    expect(run.offerer.fatals).toEqual(['a relay frame was not a ciphertext']);
    expect(run.offerer.received).toEqual([]);
  });

  it('routes a ciphertext onto the channel only after this end has switched', async () => {
    const run = pair({ opening: 'manual' });
    await cutover(run);
    // Nothing on the channel yet: the caller puts it on the relay.
    expect(run.offerer.endpoint.send(frame(1))).toBe(false);

    run.fake.openChannels();
    expect(run.offerer.endpoint.send(frame(2))).toBe(true);
    await flushMicrotasks();
    expect(run.answerer.received).toEqual([frame(2)]);
  });

  it('ends the session when a switched channel refuses a send', async () => {
    const run = pair();
    await cutover(run);
    // Closed under the endpoint, which a radio gap does between two sends.
    run.fake.offererChannel!.close();

    expect(run.offerer.endpoint.send(frame(1))).toBe(true);
    expect(run.offerer.fatals).toEqual(['the direct channel refused a message']);
  });

  it('disposes idempotently, closing the peer and reporting the relay', async () => {
    const run = pair();
    await cutover(run);

    run.offerer.endpoint.dispose();
    run.offerer.endpoint.dispose();

    expect(run.offerer.peers[0]!.closed).toBe(true);
    expect(run.offerer.endpoint.path).toBe('relay');
    expect(run.offerer.paths).toEqual(['direct', 'relay']);
    // Inert afterwards: nothing it is told does anything to a dead session, and
    // a send is consumed rather than handed back for the relay to carry.
    expect(run.offerer.endpoint.send(frame(1))).toBe(true);
    expect(run.fake.offererChannel!.sent).toEqual([]);
    run.offerer.endpoint.onSignal({ v: 1, t: 'direct-switch' });
    expect(run.offerer.fatals).toEqual([]);
  });
});
