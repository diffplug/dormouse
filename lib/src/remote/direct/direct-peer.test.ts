/**
 * The peer wrapper over the linked fake pair (`docs/specs/remote-api.md` ->
 * Transport -> "Direct path"): one negotiation, one channel, and the four ways
 * it can end. The end-to-end cases that drive it inside a real session are in
 * `../client/pocket-client.test.ts` and `../burrow/burrow-runtime.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';
import { DIRECT_GATHER_TIMEOUT_MS, DIRECT_SETUP_TIMEOUT_MS, NOISE_MAX_MESSAGE_LENGTH } from 'remote-lib-common';

import { DIRECT_CHANNEL_LABEL, DirectPeer, type DirectPeerHandlers } from './direct-peer';
import { FakeDirectNetwork, type FakeDirectNetworkOptions } from './test-fake-peer';
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
  return {
    network,
    timers,
    client,
    burrow,
    clientPeer: new DirectPeer({
      peer: network.createOfferer(),
      handlers: client,
      setTimer: timers.setTimer,
    }),
    burrowPeer: new DirectPeer({
      peer: network.createAnswerer(),
      handlers: burrow,
      setTimer: timers.setTimer,
    }),
  };
}

/** Let the fake network's queued microtasks run. */
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

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
    // And nothing may be sent on it afterwards.
    expect(clientPeer.send(Uint8Array.of(1))).toBe(false);
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

  it('closes idempotently, reporting nothing', () => {
    const { clientPeer, client } = pair();
    clientPeer.close();
    clientPeer.close();
    expect(client.closes).toEqual([]);
  });
});
