import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PAIRING_TTL_MS,
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
} from 'server-lib-common';
import { RemoteHost, type WebSocketLike } from './remote-host';
import type { HostEnrollment } from './enrollment';
import type { PendingPairing } from './pairing-approval';

// --- A fake `/ws/host` socket the test drives directly ---

class FakeSocket implements WebSocketLike {
  readyState = 1;
  readonly sent: Array<Record<string, unknown>> = [];
  readonly #handlers = new Map<string, Array<(ev: unknown) => void>>();

  addEventListener(type: string, handler: (ev: unknown) => void): void {
    const list = this.#handlers.get(type) ?? [];
    list.push(handler);
    this.#handlers.set(type, list);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = 3;
    this.#emit('close', { code: 1000 });
  }

  #emit(type: string, ev: unknown): void {
    for (const handler of this.#handlers.get(type) ?? []) handler(ev);
  }

  open(): void {
    this.#emit('open', {});
  }

  /** Deliver a server→host frame. */
  receive(frame: unknown): void {
    this.#emit('message', { data: JSON.stringify(frame) });
  }

  frames(t: string): Array<Record<string, unknown>> {
    return this.sent.filter((frame) => frame.t === t);
  }
}

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

    // client-gone disposes the session and re-gates.
    socket.receive({ t: 'client-gone', clientId: 'c1' });
    expect(disposed).toBe(1);
    socket.receive({ t: 'msg', clientId: 'c1', data: { requestId: 'r2', method: 'hello' } });
    expect(handled).toHaveLength(1);
  });
});
