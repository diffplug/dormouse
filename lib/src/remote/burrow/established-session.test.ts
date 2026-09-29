/**
 * One established session on its own, over a real Noise pair: what reaches the
 * remote-api handler, what refreshes the idle clock, and what reports the
 * session over (`docs/specs/remote-security-model.md` → Burrow bounds).
 *
 * The runtime that owns one — keying, the cap, the reaper — is
 * `burrow-runtime.test.ts` and `burrow-bounds.test.ts`; the direct path's policy
 * is `../direct/direct-endpoint.test.ts`. This file keeps only what the session
 * adds between them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ESTABLISHED_E2E_IDLE_TIMEOUT_MS,
  chunkAppMessage,
  type DirectPath,
  type DirectRelayCause,
  encodeTransportPlaintext,
  toBase64Url,
  utf8Encode,
} from 'remote-lib-common';

import { EstablishedE2eSession } from './established-session';
import type { DirectPeerFactory } from '../direct/direct-peer';
import { FakeDirectNetwork, type FakePeer } from '../direct/test-fake-peer';
import { FORGED_CT, noiseSessionPair, openReceipt } from '../test-e2e-client';
import { fakeTimers } from '../test-timers';

interface Options {
  /** Dispose the session when it reports itself over, as its owner does. */
  disposeOnFatal?: boolean;
  createDirectPeer?: DirectPeerFactory | null;
  /** What the remote-api handler does with each payload it is handed. */
  onHandle?: (payload: unknown) => void;
  /** Require the direct path for application data, as a one-time owner does. */
  directOnly?: boolean;
}

async function establish(options: Options = {}) {
  const { disposeOnFatal = true, createDirectPeer = null, onHandle, directOnly = false } = options;
  const { client, clientNoise, burrow } = await noiseSessionPair();
  const clock = { now: 1_000 };
  const handled: unknown[] = [];
  const relayed: Uint8Array[] = [];
  const fatals: string[] = [];
  const transports: Array<{ path: DirectPath; cause: DirectRelayCause | null }> = [];
  let relayedApps = 0;
  const api = { disposals: 0, send: (_payload: unknown): void => {} };
  const e2e: EstablishedE2eSession = new EstablishedE2eSession({
    session: burrow,
    createApi: (send) => {
      api.send = send;
      return {
        handle: (payload) => {
          handled.push(payload);
          onHandle?.(payload);
        },
        dispose: () => void (api.disposals += 1),
      };
    },
    createDirectPeer,
    sendRelay: (ciphertext) => void relayed.push(ciphertext),
    onFatal: (reason) => {
      fatals.push(reason);
      if (disposeOnFatal) e2e.dispose();
    },
    onTransportChanged: (path, cause) => void transports.push({ path, cause }),
    ...(directOnly ? { onRelayedApp: () => void (relayedApps += 1) } : {}),
    now: () => clock.now,
    setTimer: fakeTimers().setTimer,
  });
  /** One protocol-v1 message from the Client, on the relay. */
  const sendFromClient = (payload: unknown): void => {
    for (const ct of client.sendApp(utf8Encode(JSON.stringify(payload)))) {
      e2e.onRelayFrame(toBase64Url(ct));
    }
  };
  return {
    e2e,
    client,
    clientNoise,
    clock,
    handled,
    relayed,
    fatals,
    transports,
    relayedApps: () => relayedApps,
    api,
    sendFromClient,
  };
}

describe('EstablishedE2eSession', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hands decrypted application JSON to the remote-api handler, in order', async () => {
    const { handled, sendFromClient, fatals } = await establish();
    sendFromClient({ requestId: '1', method: 'hello' });
    sendFromClient({ requestId: '2', method: 'directory.watch' });
    expect(handled).toEqual([
      { requestId: '1', method: 'hello' },
      { requestId: '2', method: 'directory.watch' },
    ]);
    expect(fatals).toEqual([]);
  });

  it('puts the handler’s answers on the relay, encrypted on this session', async () => {
    const { api, relayed, client } = await establish();
    api.send({ requestId: '1', ok: true, result: {} });
    expect(relayed).toHaveLength(1);
    expect(openReceipt(client, relayed[0]!)).toEqual([{ requestId: '1', ok: true, result: {} }]);
  });

  it('refreshes the idle clock on a decrypted keepalive, and on nothing that failed to decrypt', async () => {
    const { e2e, client, clock } = await establish({ disposeOnFatal: false });
    expect(e2e.idleDeadlineAt).toBe(1_000 + ESTABLISHED_E2E_IDLE_TIMEOUT_MS);
    clock.now = 5_000;
    e2e.onRelayFrame(toBase64Url(client.sendKeepalive()));
    expect(e2e.idleDeadlineAt).toBe(5_000 + ESTABLISHED_E2E_IDLE_TIMEOUT_MS);
    clock.now = 9_000;
    e2e.onRelayFrame(FORGED_CT);
    expect(e2e.idleDeadlineAt).toBe(5_000 + ESTABLISHED_E2E_IDLE_TIMEOUT_MS);
  });

  it('reports a failed decrypt as fatal, and its owner’s dispose tears down the handler', async () => {
    const { e2e, handled, fatals, api, sendFromClient } = await establish();
    e2e.onRelayFrame(FORGED_CT);
    expect(fatals).toEqual(['a transport message failed to decrypt']);
    expect(api.disposals).toBe(1);
    expect(handled).toEqual([]);
    // Disposed, so nothing after it reaches the handler.
    sendFromClient({ requestId: '1', method: 'hello' });
    expect(handled).toEqual([]);
  });

  it('treats an over-size answer as the caller’s error, and a send on a poisoned session as fatal', async () => {
    const { e2e, api, fatals, relayed } = await establish({ disposeOnFatal: false });
    // Refused before the first `encryptWithAd`: no ciphertext, no moved counter.
    api.send({ oversize: 'x'.repeat(2 * 1024 * 1024) });
    expect(fatals).toEqual([]);
    expect(relayed).toEqual([]);

    e2e.onRelayFrame(FORGED_CT);
    expect(fatals).toHaveLength(1);
    api.send({ requestId: '1', ok: true, result: {} });
    expect(fatals).toEqual(['a transport message failed to decrypt', 'the transport refused a send']);
  });

  it('reports nothing once disposed, so a late report cannot end whatever replaced it', async () => {
    const { e2e, api, fatals } = await establish();
    e2e.onRelayFrame(FORGED_CT);
    expect(fatals).toHaveLength(1);
    // Poisoned and disposed: a straggling send would be fatal on a live session.
    api.send({ requestId: '1', ok: true, result: {} });
    expect(fatals).toHaveLength(1);
  });

  it('stops handing a receipt to the handler once a message disposed the session', async () => {
    let e2eRef: EstablishedE2eSession | null = null;
    const { e2e, clientNoise, handled, api } = await establish({
      // `handle` can send, and a send on a poisoned cipher disposes the session
      // from inside the receipt loop; the owner's dispose is the same act.
      onHandle: () => e2eRef?.dispose(),
    });
    e2eRef = e2e;
    // Two whole messages in one stream body, so one frame's receipt holds both.
    const body = new Uint8Array([
      ...chunkAppMessage(utf8Encode(JSON.stringify({ n: 1 })))[0]!,
      ...chunkAppMessage(utf8Encode(JSON.stringify({ n: 2 })))[0]!,
    ]);
    const plaintext = encodeTransportPlaintext({ kind: 'stream', body });
    e2e.onRelayFrame(toBase64Url(clientNoise.send.encryptWithAd(new Uint8Array(0), plaintext)));
    expect(handled).toEqual([{ n: 1 }]);
    expect(api.disposals).toBe(1);
  });

  it('answers the direct path’s signals as control messages on the relay', async () => {
    // No peer factory, as the VS Code host has: the offer is declined, and the
    // decline is a control message the Client decrypts on this session.
    const { e2e, client, relayed } = await establish();
    e2e.onRelayFrame(toBase64Url(client.sendControl({ v: 1, t: 'direct-offer', sdp: 'v=0\r\n' })));
    expect(relayed).toHaveLength(1);
    expect(openReceipt(client, relayed[0]!)).toEqual({ v: 1, t: 'direct-decline' });
  });

  it('tells its owner when the direct path changes, a decline included', async () => {
    const { e2e, client, transports } = await establish();
    e2e.onRelayFrame(toBase64Url(client.sendControl({ v: 1, t: 'direct-offer', sdp: 'v=0\r\n' })));
    expect(transports).toEqual([{ path: 'relay', cause: 'unsupported' }]);
  });

  it('hands relayed application data to the owner, never the handler, where the direct path is required', async () => {
    const { e2e, client, handled, relayed, fatals, relayedApps, sendFromClient } = await establish({
      directOnly: true,
    });
    sendFromClient({ requestId: '1', method: 'hello' });
    expect(handled).toEqual([]);
    expect(relayedApps()).toBe(1);
    // Everything that is not application data still rides the relay: a
    // keepalive, and the direct path's own signals.
    e2e.onRelayFrame(toBase64Url(client.sendKeepalive()));
    e2e.onRelayFrame(toBase64Url(client.sendControl({ v: 1, t: 'direct-offer', sdp: 'v=0\r\n' })));
    expect(openReceipt(client, relayed[0]!)).toEqual({ v: 1, t: 'direct-decline' });
    expect(relayedApps()).toBe(1);
    expect(fatals).toEqual([]);
  });

  it('disposes the direct path, then the handler, and ignores the relay afterwards', async () => {
    const network = new FakeDirectNetwork();
    const peers: FakePeer[] = [];
    const { e2e, client, api, handled, sendFromClient } = await establish({
      createDirectPeer: () => {
        const peer = network.createAnswerer();
        peers.push(peer);
        return peer;
      },
    });
    e2e.onRelayFrame(toBase64Url(client.sendControl({ v: 1, t: 'direct-offer', sdp: 'v=0\r\n' })));
    expect(peers).toHaveLength(1);
    expect(peers[0]!.closed).toBe(false);

    e2e.dispose();
    expect(peers[0]!.closed).toBe(true);
    expect(api.disposals).toBe(1);
    sendFromClient({ requestId: '1', method: 'hello' });
    expect(handled).toEqual([]);

    e2e.dispose();
    expect(api.disposals).toBe(1);
  });
});
