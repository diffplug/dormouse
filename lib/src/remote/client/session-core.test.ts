/**
 * The seams `ClientSessionCore` adds between an owner and an established
 * session, over a real Noise pair: which frame a waiter answers to, where the
 * direct path is built, and what ends a session.
 *
 * The ceremonies around it, end to end against the real Burrow, are
 * `pocket-client.test.ts`; the direct path's policy is
 * `../direct/direct-endpoint.test.ts`. This file keeps only what the core owns
 * on its own, so a second owner can rely on it without Pocket's socket.
 */

import { describe, expect, it } from 'vitest';
import {
  E2E_KEEPALIVE_INTERVAL_MS,
  ESTABLISHED_E2E_IDLE_TIMEOUT_MS,
  SESSION_END_V1,
  toBase64Url,
  utf8Encode,
  type E2eClientStep,
} from 'remote-lib-common';

import { ClientSessionCore, networkNotAllowedMessage, type CeremonyRoute } from './session-core';
import type { DirectPeerFactory } from '../direct/direct-peer';
import { FakeDirectNetwork, flushMicrotasks, type FakePeer } from '../direct/test-fake-peer';
import { FORGED_CT, noiseSessionPair, openReceipt } from '../test-e2e-client';
import { fakeTimers } from '../test-timers';

const ROUTE: CeremonyRoute = { kind: 'connection', id: 'route-a' };

const MESSAGES = {
  unavailable: 'nobody answered',
  reaped: 'the Burrow let it go',
  ended: 'the Burrow ended it',
};

/** A ceremony deadline no case waits out; the clock starts at 1 000. */
const LATER = 60_000;

interface Sent {
  route: CeremonyRoute;
  step: E2eClientStep;
  ciphertext: Uint8Array;
}

function makeCore({
  createDirectPeer = null,
  refuseSends = false,
}: { createDirectPeer?: DirectPeerFactory | null; refuseSends?: boolean } = {}) {
  const sent: Sent[] = [];
  const clock = { now: 1_000 };
  const timers = fakeTimers();
  const visibilityListeners = new Set<() => void>();
  const gone = { count: 0 };
  const core = new ClientSessionCore<CeremonyRoute>({
    sendFrame: (route, step, ciphertext) => {
      if (refuseSends) throw new Error('socket is not open');
      sent.push({ route, step, ciphertext });
    },
    messages: MESSAGES,
    now: () => clock.now,
    setTimer: timers.setTimer,
    visibility: {
      isVisible: () => true,
      subscribe(onChange) {
        visibilityListeners.add(onChange);
        return () => visibilityListeners.delete(onChange);
      },
    },
    createDirectPeer,
  });
  const endedByBurrow: boolean[] = [];
  core.setOnBurrowGone((ended) => {
    gone.count += 1;
    endedByBurrow.push(ended);
  });
  return { core, sent, clock, timers, visibilityListeners, gone, endedByBurrow };
}

describe('ceremony waiters', () => {
  it('answer only a frame on their own kind, id, and step', async () => {
    const { core, sent } = makeCore();
    const message1 = new Uint8Array([1, 2, 3]);
    const answer = core.exchange(ROUTE, message1, LATER);
    expect(sent).toEqual([{ route: ROUTE, step: 'init', ciphertext: message1 }]);

    core.onFrame({ kind: ROUTE.kind, id: 'route-b' }, 'response', 'other-id');
    core.onFrame({ kind: 'pairing', id: ROUTE.id }, 'response', 'other-kind');
    core.onFrame(ROUTE, 'transport', 'other-step');
    core.onFrame(ROUTE, 'response', 'message-2');
    await expect(answer).resolves.toBe('message-2');
  });

  it('refuse a second waiter on one key, and reclaim one whose frame never left', async () => {
    const pending = makeCore();
    const first = pending.core.exchange(ROUTE, new Uint8Array(1), LATER);
    await expect(
      pending.core.exchange(ROUTE, new Uint8Array(1), LATER),
    ).rejects.toThrow(`already awaiting 'connection:route-a:response'`);
    pending.core.rejectAll(new Error('done'));
    await expect(first).rejects.toThrow('done');

    const refused = makeCore({ refuseSends: true });
    await expect(
      refused.core.exchange(ROUTE, new Uint8Array(1), LATER),
    ).rejects.toThrow('socket is not open');
    // Reclaimed, so the same key is free for the retry.
    await expect(
      refused.core.exchange(ROUTE, new Uint8Array(1), LATER),
    ).rejects.toThrow('socket is not open');
  });

  it('report a deadline that passes unanswered in the owner’s own words', async () => {
    const { core, clock } = makeCore();
    await expect(core.exchange(ROUTE, new Uint8Array(1), clock.now)).rejects.toThrow(
      MESSAGES.unavailable,
    );
  });
});

describe('establish', () => {
  it('builds the direct path at establish and never before, and offers on it', async () => {
    const network = new FakeDirectNetwork();
    let built = 0;
    const { core, sent } = makeCore({
      createDirectPeer: () => {
        built += 1;
        return network.createOfferer();
      },
    });
    const { client, burrow } = await noiseSessionPair();
    const answer = core.exchange(ROUTE, new Uint8Array(1), LATER);
    core.onFrame(ROUTE, 'response', 'message-2');
    await answer;
    expect(built).toBe(0);
    expect(core.establishedRoute).toBeNull();

    core.establish(ROUTE, client);
    expect(built).toBe(1);
    expect(core.establishedRoute).toBe(ROUTE);
    await flushMicrotasks();
    const offer = sent.at(-1)!;
    expect(offer.route).toBe(ROUTE);
    expect(offer.step).toBe('transport');
    expect(openReceipt(burrow, offer.ciphertext)).toMatchObject({ v: 1, t: 'direct-offer' });
  });

  it('closes the previous session’s peer before building the next', async () => {
    const peers: FakePeer[] = [];
    const { core } = makeCore({
      createDirectPeer: () => {
        const peer = new FakeDirectNetwork().createOfferer();
        peers.push(peer);
        return peer;
      },
    });
    core.establish(ROUTE, (await noiseSessionPair()).client);
    const second: CeremonyRoute = { kind: 'connection', id: 'route-b' };
    core.establish(second, (await noiseSessionPair()).client);
    expect(peers).toHaveLength(2);
    expect(peers[0]!.closed).toBe(true);
    expect(peers[1]!.closed).toBe(false);
    expect(core.establishedRoute).toBe(second);
  });
});

describe('awaitDirect', () => {
  /** An established session whose offer has gone out, and the Burrow's half to answer it on. */
  async function offered() {
    const made = makeCore({ createDirectPeer: () => new FakeDirectNetwork({ opening: 'never' }).createOfferer() });
    const { client, burrow } = await noiseSessionPair();
    made.core.establish(ROUTE, client);
    await flushMicrotasks();
    openReceipt(burrow, made.sent.at(-1)!.ciphertext);
    const reply = (value: object) => made.core.onFrame(ROUTE, 'transport', toBase64Url(burrow.sendControl({ ...value })));
    return { ...made, reply };
  }

  it('answers at once with no session, and with the cause when the attempt is given up', async () => {
    expect(await makeCore().core.awaitDirect(LATER)).toBe('lost');

    const { core, reply } = await offered();
    const waiting = core.awaitDirect(LATER);
    reply({ v: 1, t: 'direct-decline' });
    expect(await waiting).toBe('declined');
    // The session itself is still up: what to do about it is the owner's.
    expect(core.establishedRoute).toBe(ROUTE);
    // Asked again, the cause is already known.
    expect(await core.awaitDirect(LATER)).toBe('declined');
  });

  it('answers with how the session ended, or that the time passed', async () => {
    const ending = await offered();
    const ended = ending.core.awaitDirect(LATER);
    ending.reply(SESSION_END_V1);
    expect(await ended).toBe('ended-by-burrow');

    const lost = await offered();
    const lostWait = lost.core.awaitDirect(LATER);
    lost.core.loseBurrow('the channel closed');
    expect(await lostWait).toBe('lost');

    const retired = await offered();
    const retiredWait = retired.core.awaitDirect(LATER);
    retired.core.endSession('connection replaced', { notifyGone: false });
    expect(await retiredWait).toBe('retired');

    const slow = await offered();
    const timedOut = slow.core.awaitDirect(LATER);
    slow.timers.fireAt(LATER);
    expect(await timedOut).toBe('timeout');
  });
});

describe('an established session', () => {
  it('carries protocol-v1 as application messages, both ways', async () => {
    const { core, sent } = makeCore();
    const { client, burrow } = await noiseSessionPair();
    core.establish(ROUTE, client);
    await flushMicrotasks();

    const hello = core.hello();
    const request = sent.at(-1)!;
    expect(request.step).toBe('transport');
    const [message] = openReceipt(burrow, request.ciphertext) as Array<{ requestId: string }>;
    expect(message).toMatchObject({ method: 'hello', params: { protocolVersion: 1, viewer: 'phone' } });

    const response = { requestId: message!.requestId, ok: true, result: { burrowId: 'b' } };
    for (const ct of burrow.sendApp(utf8Encode(JSON.stringify(response)))) {
      core.onFrame(ROUTE, 'transport', toBase64Url(ct));
    }
    await expect(hello).resolves.toEqual({ burrowId: 'b' });
  });

  it('takes only its own route’s transport frames, and ends on one that will not decrypt', async () => {
    const { core, gone } = makeCore();
    core.establish(ROUTE, (await noiseSessionPair()).client);

    // Another route's transport frame, and this route's other step, are
    // ceremony frames with nobody waiting — never this session's to decrypt.
    core.onFrame({ kind: ROUTE.kind, id: 'route-b' }, 'transport', FORGED_CT);
    core.onFrame({ kind: 'pairing', id: ROUTE.id }, 'transport', FORGED_CT);
    core.onFrame(ROUTE, 'response', FORGED_CT);
    expect(gone.count).toBe(0);
    expect(core.establishedRoute).toBe(ROUTE);

    core.onFrame(ROUTE, 'transport', FORGED_CT);
    expect(gone.count).toBe(1);
    expect(core.establishedRoute).toBeNull();
  });

  it('keepalives on its interval, and disarms on every ending', async () => {
    const { core, sent, timers, visibilityListeners, gone } = makeCore();
    const { client, burrow } = await noiseSessionPair();
    core.establish(ROUTE, client);
    const keepalive = () => timers.live.filter((t) => t.delayMs === E2E_KEEPALIVE_INTERVAL_MS);
    expect(keepalive()).toHaveLength(1);
    timers.fireAt(E2E_KEEPALIVE_INTERVAL_MS);
    expect(openReceipt(burrow, sent.at(-1)!.ciphertext)).toBe('keepalive');
    expect(keepalive()).toHaveLength(1);

    const inFlight = core.hello();
    core.endSession('replaced', { notifyGone: false });
    await expect(inFlight).rejects.toThrow('replaced');
    expect(keepalive()).toHaveLength(0);
    expect(visibilityListeners.size).toBe(0);
    expect(gone.count).toBe(0);
  });

  it('ends a session the Burrow has already reaped, in the owner’s words', async () => {
    const { core, clock, gone, sent } = makeCore();
    core.establish(ROUTE, (await noiseSessionPair()).client);
    const inFlight = core.hello();
    const sentBefore = sent.length;

    clock.now += ESTABLISHED_E2E_IDLE_TIMEOUT_MS;
    core.sendKeepalive();
    // A reap sends nothing: there is no frame for a session already gone.
    expect(sent).toHaveLength(sentBefore);
    expect(gone.count).toBe(1);
    expect(core.establishedRoute).toBeNull();
    await expect(inFlight).rejects.toThrow(MESSAGES.reaped);
  });

  it('fails a request on a reaped session rather than sending it', async () => {
    const { core, clock, gone, sent } = makeCore();
    core.establish(ROUTE, (await noiseSessionPair()).client);
    const sentBefore = sent.length;

    clock.now += ESTABLISHED_E2E_IDLE_TIMEOUT_MS;
    await expect(core.hello()).rejects.toThrow(MESSAGES.reaped);
    expect(sent).toHaveLength(sentBefore);
    expect(gone.count).toBe(1);
  });

  it('ends on the Burrow’s goodbye, failing what is in flight in the owner’s words', async () => {
    const { core, gone, endedByBurrow } = makeCore();
    const { client, burrow } = await noiseSessionPair();
    core.establish(ROUTE, client);
    const inFlight = core.hello();

    core.onFrame(ROUTE, 'transport', toBase64Url(burrow.sendControl({ ...SESSION_END_V1 })));
    expect(gone.count).toBe(1);
    // The one loss the Burrow names: only the goodbye reports it ended the session.
    expect(endedByBurrow).toEqual([true]);
    expect(core.establishedRoute).toBeNull();
    await expect(inFlight).rejects.toThrow(MESSAGES.ended);
  });

  it('keeps the goodbye that ended the session, for its owner’s copy, until the next is established', async () => {
    const { core } = makeCore();
    const first = await noiseSessionPair();
    core.establish(ROUTE, first.client);
    expect(core.goodbye).toBeNull();
    const refused = { ...SESSION_END_V1, reason: 'network-not-allowed', address: '172.58.12.9', addressSource: 'observed' };
    core.onFrame(ROUTE, 'transport', toBase64Url(first.burrow.sendControl(refused)));
    expect(core.goodbye).toEqual(refused);

    core.establish(ROUTE, (await noiseSessionPair()).client);
    expect(core.goodbye).toBeNull();
  });

  it('words a goodbye the path ended by the address it names, and nothing for one that names none', () => {
    const refused = { ...SESSION_END_V1, reason: 'network-not-allowed' } as const;
    expect(networkNotAllowedMessage({ ...refused, address: '172.58.12.9', addressSource: 'observed' })).toBe(
      'This computer only accepts phones on its allowed networks. Yours connected from 172.58.12.9 — ' +
        'join the same Wi-Fi or VPN as the computer and try again.',
    );
    // The phone's own claim is never worded as where it connected from, nor as off the networks.
    expect(networkNotAllowedMessage({ ...refused, address: '172.58.12.9', addressSource: 'reported' })).toBe(
      'This phone couldn’t reach the computer directly over one of its allowed networks (it reported 172.58.12.9). ' +
        'If it’s on another network, join the same Wi-Fi or VPN as the computer and try again.',
    );
    // No address — the computer's own end refused, or nothing to name — is
    // never a reason to send the phone to another network: the generic copy.
    expect(networkNotAllowedMessage(refused)).toBeNull();
    expect(networkNotAllowedMessage(SESSION_END_V1)).toBeNull();
    expect(networkNotAllowedMessage(null)).toBeNull();
  });

  it('ignores a control shape it does not know, and stays connected', async () => {
    // What an older Client does with the goodbye, and this one with whatever a
    // newer Burrow adds: an unknown control message is never a session failure.
    const { core, gone, sent } = makeCore();
    const { client, burrow } = await noiseSessionPair();
    core.establish(ROUTE, client);
    for (const value of [
      { v: 1, t: 'session-pause' },
      { v: 2, t: 'session-end' },
      { v: 1, t: 'session-end', reason: 'take-back' },
    ]) {
      core.onFrame(ROUTE, 'transport', toBase64Url(burrow.sendControl(value)));
    }
    expect(gone.count).toBe(0);
    expect(core.establishedRoute).toBe(ROUTE);

    const hello = core.hello();
    const [message] = openReceipt(burrow, sent.at(-1)!.ciphertext) as Array<{ requestId: string }>;
    const response = { requestId: message!.requestId, ok: true, result: { burrowId: 'b' } };
    for (const ct of burrow.sendApp(utf8Encode(JSON.stringify(response)))) {
      core.onFrame(ROUTE, 'transport', toBase64Url(ct));
    }
    await expect(hello).resolves.toEqual({ burrowId: 'b' });
  });

  it('reports every other loss as not ended by the Burrow', async () => {
    const { core, endedByBurrow } = makeCore();
    core.establish(ROUTE, (await noiseSessionPair()).client);
    core.onFrame(ROUTE, 'transport', FORGED_CT);
    expect(endedByBurrow).toEqual([false]);
  });
});
