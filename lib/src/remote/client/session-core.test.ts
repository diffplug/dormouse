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
  NoiseTransportSession,
  createNoiseInitiator,
  createNoiseResponder,
  e2eConnectionPrologue,
  generateNoiseKeyPair,
  toBase64Url,
  utf8Decode,
  utf8Encode,
  type E2eClientStep,
} from 'remote-lib-common';

import { ClientSessionCore, type CeremonyRoute } from './session-core';
import type { DirectPeerFactory } from '../direct/direct-peer';
import { FakeDirectNetwork, flushMicrotasks, type FakePeer } from '../direct/test-fake-peer';
import { fakeTimers } from '../test-timers';

/** A completed IK handshake: the Client's transport to establish, and the Burrow's. */
async function sessionPair(): Promise<{
  client: NoiseTransportSession;
  burrow: NoiseTransportSession;
}> {
  const prologue = e2eConnectionPrologue('burrow', 'connection');
  const burrowStatic = await generateNoiseKeyPair();
  const initiator = await createNoiseInitiator({
    prologue,
    staticKeyPair: await generateNoiseKeyPair(),
    remoteStaticPublicKey: burrowStatic.publicKey,
  });
  const responder = await createNoiseResponder({ prologue, staticKeyPair: burrowStatic });
  await responder.readMessage(await initiator.writeMessage());
  await initiator.readMessage(await responder.writeMessage());
  return {
    client: new NoiseTransportSession(initiator.session),
    burrow: new NoiseTransportSession(responder.session),
  };
}

const ROUTE: CeremonyRoute = { kind: 'connection', id: 'route-a' };

const MESSAGES = { unavailable: 'nobody answered', reaped: 'the Burrow let it go' };

/** A ceremony deadline no case waits out; the clock starts at 1 000. */
const LATER = 60_000;

/** Bytes that decode as a `ct` and authenticate as nothing. */
const FORGED_CT = toBase64Url(new Uint8Array(64));

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
  core.setOnBurrowGone(() => void (gone.count += 1));
  return { core, sent, clock, timers, visibilityListeners, gone };
}

/** What one Client→Burrow ciphertext opens to on the Burrow's side. */
function openOnBurrow(burrow: NoiseTransportSession, ciphertext: Uint8Array): unknown {
  const receipt = burrow.receive(ciphertext);
  if (receipt.kind === 'control') return receipt.value;
  if (receipt.kind === 'app') return receipt.messages.map((m) => JSON.parse(utf8Decode(m)));
  return receipt.kind;
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
    const { client, burrow } = await sessionPair();
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
    expect(openOnBurrow(burrow, offer.ciphertext)).toMatchObject({ v: 1, t: 'direct-offer' });
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
    core.establish(ROUTE, (await sessionPair()).client);
    const second: CeremonyRoute = { kind: 'connection', id: 'route-b' };
    core.establish(second, (await sessionPair()).client);
    expect(peers).toHaveLength(2);
    expect(peers[0]!.closed).toBe(true);
    expect(peers[1]!.closed).toBe(false);
    expect(core.establishedRoute).toBe(second);
  });
});

describe('an established session', () => {
  it('carries protocol-v1 as application messages, both ways', async () => {
    const { core, sent } = makeCore();
    const { client, burrow } = await sessionPair();
    core.establish(ROUTE, client);
    await flushMicrotasks();

    const hello = core.hello();
    const request = sent.at(-1)!;
    expect(request.step).toBe('transport');
    const [message] = openOnBurrow(burrow, request.ciphertext) as Array<{ requestId: string }>;
    expect(message).toMatchObject({ method: 'hello', params: { protocolVersion: 1, viewer: 'phone' } });

    const response = { requestId: message!.requestId, ok: true, result: { burrowId: 'b' } };
    for (const ct of burrow.sendApp(utf8Encode(JSON.stringify(response)))) {
      core.onFrame(ROUTE, 'transport', toBase64Url(ct));
    }
    await expect(hello).resolves.toEqual({ burrowId: 'b' });
  });

  it('takes only its own route’s transport frames, and ends on one that will not decrypt', async () => {
    const { core, gone } = makeCore();
    core.establish(ROUTE, (await sessionPair()).client);

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
    const { client, burrow } = await sessionPair();
    core.establish(ROUTE, client);
    const keepalive = () => timers.live.filter((t) => t.delayMs === E2E_KEEPALIVE_INTERVAL_MS);
    expect(keepalive()).toHaveLength(1);
    timers.fireAt(E2E_KEEPALIVE_INTERVAL_MS);
    expect(openOnBurrow(burrow, sent.at(-1)!.ciphertext)).toBe('keepalive');
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
    core.establish(ROUTE, (await sessionPair()).client);
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
    core.establish(ROUTE, (await sessionPair()).client);
    const sentBefore = sent.length;

    clock.now += ESTABLISHED_E2E_IDLE_TIMEOUT_MS;
    await expect(core.hello()).rejects.toThrow(MESSAGES.reaped);
    expect(sent).toHaveLength(sentBefore);
    expect(gone.count).toBe(1);
  });
});
