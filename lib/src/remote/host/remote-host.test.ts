import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Holds one `authorizeConnection` call open per queued gate, in call order, so a
 * test can make an *older* evaluation finish last. Everything else about the
 * module is the real thing — the decision itself is never faked.
 */
const authProbe = vi.hoisted(() => ({ gates: [] as Array<Promise<void> | undefined>, calls: 0 }));
vi.mock('server-lib-common', async (importOriginal) => {
  const real = await importOriginal<typeof import('server-lib-common')>();
  return {
    ...real,
    authorizeConnection: async (context: never, request: never) => {
      const gate = authProbe.gates[authProbe.calls++];
      const decision = await real.authorizeConnection(context, request);
      await gate;
      return decision;
    },
  };
});

import {
  DEFAULT_PAIRING_TTL_MS,
  WS_CLOSE_HOST_REPLACED,
  concatBytes,
  ecdsaRawToDer,
  generateDeviceKeyPair,
  hashPasskeyPublicKey,
  signDeviceChallenge,
  toBase64Url,
  utf8Encode,
  type ConnectionRequest,
  type HostAclRecord,
  type PairingRequest,
  MAX_PENDING_PAIRINGS,
} from 'server-lib-common';
import { RemoteHost } from './remote-host';
import type { HostEnrollment } from './enrollment';
import type { PendingPairing } from './pairing-approval';
import { FakeSocket } from '../test-fake-socket';

const ENROLLMENT: HostEnrollment = {
  serverUrl: 'https://host.example',
  hostId: 'host-1',
  hostToken: 'tok',
  origin: 'https://host.example',
  rpId: 'host.example',
};

// --- Minimal faithful WebAuthn authenticator (mirrors test/harness/actors.mjs) ---

const subtle = globalThis.crypto.subtle;

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest('SHA-256', bytes));
}

async function createAuthenticator(rpId: string) {
  const keyPair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const spki = new Uint8Array(await subtle.exportKey('spki', keyPair.publicKey));
  const publicKey = toBase64Url(spki);
  const credentialId = toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  let signCount = 0;

  async function assert(challenge: string, origin: string) {
    const clientDataJSON = utf8Encode(
      JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }),
    );
    const rpIdHash = await sha256(utf8Encode(rpId));
    signCount += 1;
    const flags = 0x01 | 0x04; // user present + user verified
    const authenticatorData = concatBytes(
      rpIdHash,
      Uint8Array.of(flags, (signCount >>> 24) & 0xff, (signCount >>> 16) & 0xff, (signCount >>> 8) & 0xff, signCount & 0xff),
    );
    const rawSignature = new Uint8Array(
      await subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keyPair.privateKey,
        concatBytes(authenticatorData, await sha256(clientDataJSON)),
      ),
    );
    return {
      credentialId,
      clientDataJSON: toBase64Url(clientDataJSON),
      authenticatorData: toBase64Url(authenticatorData),
      signature: toBase64Url(ecdsaRawToDer(rawSignature)),
    };
  }

  return { publicKey, credentialId, assert };
}

async function flushUntil<T>(get: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for frame');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Drive connect → connect2 and return the decision frame. */
async function runConnect(
  socket: FakeSocket,
  clientId: string,
  build: (challenge: string) => Promise<ConnectionRequest>,
): Promise<Record<string, unknown>> {
  socket.sent.length = 0;
  socket.receive({ t: 'connect', clientId });
  const challengeFrame = socket.frames('challenge')[0]!;
  const request = await build(challengeFrame.challenge as string);
  socket.receive({ t: 'connect2', clientId, request });
  return flushUntil(() => socket.frames('decision')[0]);
}

/** A promise a test releases by hand. */
function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Let every already-queued microtask run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe('RemoteHost frame handling', () => {
  let socket: FakeSocket;
  let savedRecords: HostAclRecord[] = [];
  let approvals: PendingPairing[] = [];

  function makeHost(
    loadAcl: () => HostAclRecord[] = () => [],
    now: () => number = () => Date.now(),
  ) {
    savedRecords = [];
    approvals = [];
    const host = new RemoteHost({
      enrollment: ENROLLMENT,
      reconnect: false,
      createWebSocket: () => (socket = new FakeSocket()),
      loadAcl,
      saveAcl: (_hostId, records) => {
        savedRecords = [...records];
      },
      requestApproval: (pending) => approvals.push(pending),
      dismissApproval: () => {},
      now,
    });
    host.start();
    socket.open();
    return host;
  }

  beforeEach(() => {
    socket = new FakeSocket();
    authProbe.gates.length = 0;
    authProbe.calls = 0;
  });

  it('pair → local approval → pair-result with the ACL record, and persists', () => {
    makeHost();
    const request: PairingRequest = {
      accountId: 'owner',
      passkeyCredentialId: 'cred-1',
      passkeyPublicKeyHash: 'hash-1',
      devicePublicKey: 'device-1',
      requestedLabel: 'iPhone Safari',
    };
    socket.receive({ t: 'pair', clientId: 'c1', request });

    // No ACL write until the local user approves.
    expect(socket.frames('pair-result')).toHaveLength(0);
    expect(approvals).toHaveLength(1);

    approvals[0]!.approve();

    const result = socket.frames('pair-result')[0]!;
    expect(result).toMatchObject({ clientId: 'c1', approved: true });
    expect((result.record as HostAclRecord).devicePublicKey).toBe('device-1');
    expect((result.record as HostAclRecord).label).toBe('iPhone Safari');
    // The approval wrote and persisted the ACL.
    expect(savedRecords).toHaveLength(1);
    expect(savedRecords[0]!.passkeyCredentialId).toBe('cred-1');
  });

  it.each([
    ['a missing request', undefined],
    ['a non-object request', 'not-an-object'],
    ['a request missing devicePublicKey', { accountId: 'owner', passkeyCredentialId: 'c', passkeyPublicKeyHash: 'h', requestedLabel: 'x' }],
    ['a request with a non-string label', { accountId: 'owner', passkeyCredentialId: 'c', passkeyPublicKeyHash: 'h', devicePublicKey: 'd', requestedLabel: { evil: true } }],
  ])('malformed pair frame (%s) is denied and never reaches the approval UI', (_label, request) => {
    makeHost();
    // The relay is not trusted, so the Host runs the same shape guard the
    // Server does. Unguarded, these reach the modal, where rendering them
    // throws inside the app-wide ErrorBoundary and takes every terminal down.
    socket.receive({ t: 'pair', clientId: 'c1', request });

    expect(approvals).toHaveLength(0);
    expect(socket.frames('pair-result')[0]).toMatchObject({
      clientId: 'c1',
      approved: false,
      error: 'malformed-request',
    });
    expect(savedRecords).toHaveLength(0);
  });

  it('bounds and strips requestedLabel before it reaches the approval UI', () => {
    makeHost();
    socket.receive({
      t: 'pair',
      clientId: 'c1',
      request: {
        passkeyCredentialId: 'cred-1',
        passkeyPublicKeyHash: 'hash-1',
        devicePublicKey: 'device-1',
        // A bidi override plus far more text than the modal can show.
        requestedLabel: `\u202eiPhone${'A'.repeat(500)}`,
        accountId: `\u202eowner${'B'.repeat(500)}`,
      },
    });

    const shown = approvals[0]!.request.requestedLabel;
    expect(shown).not.toContain('\u202e');
    expect(Array.from(shown).length).toBeLessThanOrEqual(64);
    // `accountId` is the modal's other rendered field and is just as
    // attacker-chosen; bounding one without the other only moves the overflow.
    expect(Array.from(approvals[0]!.request.accountId).length).toBeLessThanOrEqual(64);

    approvals[0]!.approve();
    // The bound applies to what is persisted too, not only to what is shown.
    expect(Array.from(savedRecords[0]!.label).length).toBeLessThanOrEqual(64);
  });

  it('bounds pending pairings so pair frames cannot grow the host unbounded', () => {
    const host = makeHost();
    // Every `pair` frame allocates under a relay-chosen clientId, and
    // `client-gone` — the only thing that removes one — is what a hostile relay
    // simply never sends. Unbounded, 5000 frames retained 5000 requests holding
    // megabytes of relay-chosen strings in the process that owns every PTY.
    const sent = 200;
    for (let i = 0; i < sent; i++) {
      socket.receive({
        t: 'pair',
        clientId: `c${i}`,
        request: {
          accountId: 'owner',
          passkeyCredentialId: `cred-${i}`,
          passkeyPublicKeyHash: `hash-${i}`,
          devicePublicKey: `device-${i}`,
          requestedLabel: `iPhone ${i}`,
        },
      });
    }

    // `approvals` is the harness's cumulative call log, so it counts every
    // request ever shown — the live queue is what is bounded. Evictions are
    // observable as denials on the wire, which is also the point: an evicted
    // client is told, rather than left waiting on a modal that no longer
    // exists.
    const denials = socket.frames('pair-result').filter((f) => f.approved === false);
    expect(denials).toHaveLength(sent - MAX_PENDING_PAIRINGS);
    expect(denials.every((f) => f.error === 'superseded')).toBe(true);
    // The record is dropped, not just the payload it holds: evicting only
    // `pending` would free the capped request and keep the slot plus its
    // relay-chosen key forever, which is the unbounded half. This bounds the
    // pairing path — `connect` frames allocate through a different route that
    // this counter deliberately does not evict.
    expect(host.trackedClientCount).toBeLessThanOrEqual(MAX_PENDING_PAIRINGS);

    // Nothing reached the ACL without a human.
    expect(savedRecords).toHaveLength(0);
  });

  it('deny → pair-result approved:false, ACL untouched', () => {
    makeHost();
    socket.receive({
      t: 'pair',
      clientId: 'c1',
      request: {
        accountId: 'owner',
        passkeyCredentialId: 'cred-1',
        passkeyPublicKeyHash: 'hash-1',
        devicePublicKey: 'device-1',
        requestedLabel: 'iPhone Safari',
      } satisfies PairingRequest,
    });
    approvals[0]!.deny();

    const result = socket.frames('pair-result')[0]!;
    expect(result).toMatchObject({ clientId: 'c1', approved: false });
    expect(result.record).toBeUndefined();
    expect(savedRecords).toEqual([]);
  });

  it('ignores approval callbacks superseded under the same client id', () => {
    makeHost();
    const first = {
      accountId: 'owner',
      passkeyCredentialId: 'cred-1',
      passkeyPublicKeyHash: 'hash-1',
      devicePublicKey: 'device-1',
      requestedLabel: 'iPhone Safari',
    } satisfies PairingRequest;
    socket.receive({ t: 'pair', clientId: 'c1', request: first });
    const stale = approvals[0]!;

    const replacement = {
      ...first,
      devicePublicKey: 'device-2',
      requestedLabel: 'Android Chrome',
    };
    socket.receive({ t: 'pair', clientId: 'c1', request: replacement });
    expect(approvals[1]!.pairingId).not.toBe(stale.pairingId);

    stale.approve();
    stale.deny();
    expect(socket.frames('pair-result')).toEqual([]);
    expect(savedRecords).toEqual([]);

    approvals[1]!.approve();
    expect(socket.frames('pair-result')[0]).toMatchObject({
      approved: true,
      record: { devicePublicKey: 'device-2' },
    });
  });

  it('expired approval → pair-result approved:false, ACL untouched', () => {
    let now = 1_000;
    makeHost(() => [], () => now);
    socket.receive({
      t: 'pair',
      clientId: 'c1',
      request: {
        accountId: 'owner',
        passkeyCredentialId: 'cred-1',
        passkeyPublicKeyHash: 'hash-1',
        devicePublicKey: 'device-1',
        requestedLabel: 'iPhone Safari',
      } satisfies PairingRequest,
    });
    now += DEFAULT_PAIRING_TTL_MS;

    approvals[0]!.approve();

    const result = socket.frames('pair-result')[0]!;
    expect(result).toMatchObject({
      clientId: 'c1',
      approved: false,
      error: 'pairing approval expired',
    });
    expect(result.record).toBeUndefined();
    expect(savedRecords).toEqual([]);
  });

  it('connect issues a challenge frame', () => {
    makeHost();
    socket.receive({ t: 'connect', clientId: 'c1' });
    const challenge = socket.frames('challenge')[0]!;
    expect(challenge.clientId).toBe('c1');
    expect(typeof challenge.challenge).toBe('string');
    expect(typeof challenge.expiresAt).toBe('number');
  });

  it('connect2 for an unpaired device denies with failures', async () => {
    makeHost();
    const authenticator = await createAuthenticator(ENROLLMENT.rpId);
    const deviceKey = await generateDeviceKeyPair();

    const decision = await runConnect(socket, 'c1', async (challenge) => ({
      accountId: 'owner',
      devicePublicKey: deviceKey.devicePublicKey,
      challenge,
      deviceSignature: await signDeviceChallenge(deviceKey.privateKey, {
        hostId: ENROLLMENT.hostId,
        challenge,
        devicePublicKey: deviceKey.devicePublicKey,
      }),
      passkey: {
        publicKey: authenticator.publicKey,
        assertion: await authenticator.assert(challenge, ENROLLMENT.origin),
      },
    }));

    expect(decision).toMatchObject({ clientId: 'c1', allowed: false });
    expect(decision.failures).toEqual(
      expect.arrayContaining(['passkey-not-paired', 'device-not-paired']),
    );
  });

  it('contains and denies a malformed connect2 from the relay', async () => {
    makeHost();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    socket.receive({ t: 'connect2', clientId: 'c1', request: {} });

    const decision = await flushUntil(() => socket.frames('decision')[0]);
    expect(decision).toMatchObject({ clientId: 'c1', allowed: false });
    expect(decision.failures).toEqual(
      expect.arrayContaining(['passkey-assertion-invalid', 'device-signature-invalid']),
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('pair then connect2 allows and omits failures', async () => {
    makeHost();
    const authenticator = await createAuthenticator(ENROLLMENT.rpId);
    const deviceKey = await generateDeviceKeyPair();
    const passkeyPublicKeyHash = await hashPasskeyPublicKey(authenticator.publicKey);

    // Pair this exact (passkey, device) pair through the real ceremony.
    socket.receive({
      t: 'pair',
      clientId: 'c1',
      request: {
        accountId: 'owner',
        passkeyCredentialId: authenticator.credentialId,
        passkeyPublicKeyHash,
        devicePublicKey: deviceKey.devicePublicKey,
        requestedLabel: 'iPhone Safari',
      } satisfies PairingRequest,
    });
    approvals[0]!.approve();
    expect(socket.frames('pair-result')[0]).toMatchObject({ approved: true });

    const decision = await runConnect(socket, 'c1', async (challenge) => ({
      accountId: 'owner',
      devicePublicKey: deviceKey.devicePublicKey,
      challenge,
      deviceSignature: await signDeviceChallenge(deviceKey.privateKey, {
        hostId: ENROLLMENT.hostId,
        challenge,
        devicePublicKey: deviceKey.devicePublicKey,
      }),
      passkey: {
        publicKey: authenticator.publicKey,
        assertion: await authenticator.assert(challenge, ENROLLMENT.origin),
      },
    }));

    expect(decision).toMatchObject({ clientId: 'c1', allowed: true });
    // `failures` is omitted from an allowed decision.
    expect('failures' in decision).toBe(false);
  });

  it('gates msg on an allowed decision and routes to a session', async () => {
    const handled: unknown[] = [];
    let disposed = 0;
    savedRecords = [];
    approvals = [];
    const host = new RemoteHost({
      enrollment: ENROLLMENT,
      reconnect: false,
      createWebSocket: () => (socket = new FakeSocket()),
      loadAcl: () => [],
      saveAcl: () => {},
      requestApproval: (pending) => pending.approve(),
      dismissApproval: () => {},
      createSession: () => ({
        handle: (data) => handled.push(data),
        dispose: () => {
          disposed += 1;
        },
      }),
    });
    host.start();
    socket.open();

    // Before any allowed decision, msg is dropped (the host-side gate).
    socket.receive({ t: 'msg', clientId: 'c1', data: { requestId: 'r', method: 'hello' } });
    expect(handled).toHaveLength(0);

    // Force an allowed decision by pairing + connecting.
    const authenticator = await createAuthenticator(ENROLLMENT.rpId);
    const deviceKey = await generateDeviceKeyPair();
    const passkeyPublicKeyHash = await hashPasskeyPublicKey(authenticator.publicKey);
    socket.receive({
      t: 'pair',
      clientId: 'c1',
      request: {
        accountId: 'owner',
        passkeyCredentialId: authenticator.credentialId,
        passkeyPublicKeyHash,
        devicePublicKey: deviceKey.devicePublicKey,
        requestedLabel: 'x',
      } satisfies PairingRequest,
    });
    await runConnect(socket, 'c1', async (challenge) => ({
      accountId: 'owner',
      devicePublicKey: deviceKey.devicePublicKey,
      challenge,
      deviceSignature: await signDeviceChallenge(deviceKey.privateKey, {
        hostId: ENROLLMENT.hostId,
        challenge,
        devicePublicKey: deviceKey.devicePublicKey,
      }),
      passkey: {
        publicKey: authenticator.publicKey,
        assertion: await authenticator.assert(challenge, ENROLLMENT.origin),
      },
    }));

    socket.receive({ t: 'msg', clientId: 'c1', data: { requestId: 'r', method: 'hello' } });
    expect(handled).toHaveLength(1);

    // A new, malformed authorization attempt fails closed and revokes this
    // connection's message gate. The relay is not an authority merely because
    // this clientId was allowed once.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    socket.sent.length = 0;
    socket.receive({ t: 'connect2', clientId: 'c1', request: {} });
    await flushUntil(() => socket.frames('decision')[0]);
    socket.receive({ t: 'msg', clientId: 'c1', data: { requestId: 'r2', method: 'hello' } });
    expect(handled).toHaveLength(1);
    expect(disposed).toBe(1);
    warn.mockRestore();

    // client-gone disposes the session and re-gates.
    socket.receive({ t: 'client-gone', clientId: 'c1' });
    // The failed re-authorization already disposed it; client-gone is
    // idempotent rather than disposing the old session twice.
    expect(disposed).toBe(1);
    socket.receive({ t: 'msg', clientId: 'c1', data: { requestId: 'r3', method: 'hello' } });
    expect(handled).toHaveLength(1);
  });

  it('lets only the newest connect2 answer, even when an older one lands last', async () => {
    // Verification is async and the relay can start a second attempt while the
    // first is still running. An older `allowed` landing last would re-open the
    // gate the newer attempt closed — the relay would then have talked this Host
    // into establishing a client it had just denied.
    const handled: unknown[] = [];
    savedRecords = [];
    approvals = [];
    const host = new RemoteHost({
      enrollment: ENROLLMENT,
      reconnect: false,
      createWebSocket: () => (socket = new FakeSocket()),
      loadAcl: () => [],
      saveAcl: () => {},
      requestApproval: (pending) => pending.approve(),
      dismissApproval: () => {},
      createSession: () => ({ handle: (data) => handled.push(data), dispose: () => {} }),
    });
    host.start();
    socket.open();

    const authenticator = await createAuthenticator(ENROLLMENT.rpId);
    const deviceKey = await generateDeviceKeyPair();
    const passkeyPublicKeyHash = await hashPasskeyPublicKey(authenticator.publicKey);
    socket.receive({
      t: 'pair',
      clientId: 'c1',
      request: {
        accountId: 'owner',
        passkeyCredentialId: authenticator.credentialId,
        passkeyPublicKeyHash,
        devicePublicKey: deviceKey.devicePublicKey,
        requestedLabel: 'x',
      } satisfies PairingRequest,
    });

    // The older attempt would be allowed — and is held open until after the
    // newer one has been answered.
    const held = gate();
    authProbe.gates[authProbe.calls] = held.promise;
    socket.sent.length = 0;
    socket.receive({ t: 'connect', clientId: 'c1' });
    const challenge = socket.frames('challenge')[0]!.challenge as string;
    socket.receive({
      t: 'connect2',
      clientId: 'c1',
      request: {
        accountId: 'owner',
        devicePublicKey: deviceKey.devicePublicKey,
        challenge,
        deviceSignature: await signDeviceChallenge(deviceKey.privateKey, {
          hostId: ENROLLMENT.hostId,
          challenge,
          devicePublicKey: deviceKey.devicePublicKey,
        }),
        passkey: {
          publicKey: authenticator.publicKey,
          assertion: await authenticator.assert(challenge, ENROLLMENT.origin),
        },
      } satisfies ConnectionRequest,
    });
    await settle();
    expect(socket.frames('decision')).toHaveLength(0);

    // The newer attempt is malformed, so it denies and closes the gate.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    socket.receive({ t: 'connect2', clientId: 'c1', request: {} });
    expect(await flushUntil(() => socket.frames('decision')[0])).toMatchObject({ allowed: false });

    held.release();
    await settle();

    // The superseded evaluation answers nothing at all — a second `decision`
    // would settle a request the client is no longer waiting on.
    expect(socket.frames('decision')).toHaveLength(1);
    socket.receive({ t: 'msg', clientId: 'c1', data: { requestId: 'r', method: 'hello' } });
    expect(handled).toHaveLength(0);
    warn.mockRestore();
  });
});

describe('RemoteHost close-code policy', () => {
  /** Every socket the host has opened, in order. */
  let sockets: FakeSocket[] = [];
  let live: RemoteHost | null = null;

  /** A host with the real reconnect policy (backoff timers under fake timers). */
  function makeHost(): RemoteHost {
    sockets = [];
    const host = new RemoteHost({
      enrollment: ENROLLMENT,
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      loadAcl: () => [],
      saveAcl: () => {},
      requestApproval: () => {},
      dismissApproval: () => {},
    });
    live = host;
    host.start();
    sockets[0]!.open();
    expect(host.status).toBe('connected');
    return host;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    live?.stop();
    live = null;
    vi.useRealTimers();
  });

  it('reconnects after a transient close', () => {
    const host = makeHost();

    sockets[0]!.closeWith(1006); // abnormal closure — a Wi-Fi blip
    expect(host.status).toBe('disconnected');
    expect(sockets).toHaveLength(1);

    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(host.status).toBe('connected');
  });

  it('stands down on a displacement close instead of reconnecting', () => {
    const host = makeHost();

    sockets[0]!.closeWith(WS_CLOSE_HOST_REPLACED);
    expect(host.status).toBe('displaced');

    // No timer brings it back — fighting the newer Host for the hostId is the
    // bug this close code exists to prevent.
    vi.advanceTimersByTime(10 * 60_000);
    expect(sockets).toHaveLength(1);
    expect(host.status).toBe('displaced');
  });

  it('start() is the explicit way back from displaced', () => {
    const host = makeHost();
    sockets[0]!.closeWith(WS_CLOSE_HOST_REPLACED);
    expect(host.status).toBe('displaced');

    host.start();
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(host.status).toBe('connected');

    // And the reconnect policy is intact afterwards.
    sockets[1]!.closeWith(1006);
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(3);
  });

  it('ignores a close from a socket it no longer owns', () => {
    const host = makeHost();
    sockets[0]!.closeWith(1006);
    vi.advanceTimersByTime(1_000);
    sockets[1]!.open();
    expect(host.status).toBe('connected');

    // The relay evicts the *dead* first socket. That close says nothing about
    // the live one, so it must not stand this Host down.
    sockets[0]!.closeWith(WS_CLOSE_HOST_REPLACED);
    expect(host.status).toBe('connected');
    expect(sockets).toHaveLength(2);
  });

  it('stop() wins over a displacement close', () => {
    const host = makeHost();
    host.stop();
    expect(host.status).toBe('stopped');

    // `stop()` drops the socket reference without waiting for its close event.
    sockets[0]!.closeWith(WS_CLOSE_HOST_REPLACED);
    expect(host.status).toBe('stopped');
  });
});
