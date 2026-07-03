/**
 * Pocket protocol-client coverage with faked fetch / WebAuthn / WebSocket, plus
 * the injected-store device-key logic. Everything crypto-touching
 * (`generateDeviceKeyPair`, `signDeviceChallenge`, `hashPasskeyPublicKey`) runs
 * for real against Node's WebCrypto; only the browser/network edges are faked.
 *
 * (fake-indexeddb is not a dependency, so the IndexedDB round-trip itself is not
 * exercised here — `getOrCreateDeviceKey` is tested through an injected store.)
 */

import { describe, expect, it } from 'vitest';
import {
  SELFHOST_ACCOUNT_ID,
  generateDeviceKeyPair,
  hashPasskeyPublicKey,
  toBase64Url,
  type DeviceKeyPair,
  type PasskeyAssertion,
} from 'server-lib-common';

import {
  PocketClient,
  type PocketSocket,
  type PocketStorage,
  type PocketClientDeps,
} from './pocket-client';
import { getOrCreateDeviceKey, type DeviceKeyStore } from './device-key';
import type { PasskeyRegistration, WebAuthnClient } from './webauthn';

// --- Fakes -----------------------------------------------------------------

const CREDENTIAL_ID = 'cred-123';
const PASSKEY_PUBLIC_KEY = 'pk-spki-b64u';
const RP_ID = 'localhost';

/** A base64url string usable as a real challenge (device signing decodes it). */
function b64uChallenge(seed: number): string {
  return toBase64Url(Uint8Array.from({ length: 32 }, (_, i) => (seed + i) & 0xff));
}

const assertion: PasskeyAssertion = {
  credentialId: CREDENTIAL_ID,
  clientDataJSON: 'client-data',
  authenticatorData: 'auth-data',
  signature: 'sig',
};

const fakeWebAuthn: WebAuthnClient = {
  async registerPasskey(): Promise<PasskeyRegistration> {
    return {
      credentialId: CREDENTIAL_ID,
      publicKey: PASSKEY_PUBLIC_KEY,
      clientDataJSON: 'create-client-data',
    };
  },
  async getAssertion(): Promise<PasskeyAssertion> {
    return assertion;
  },
};

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A router-style fake `fetch` that records every call. */
function makeFetch(routes: Record<string, (body: unknown) => { status?: number; json: unknown }>) {
  const calls: FetchCall[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'POST';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, headers, body });
    const path = new URL(url, 'http://test').pathname;
    const handler = routes[path];
    if (!handler) throw new Error(`unexpected fetch: ${path}`);
    const { status = 200, json } = handler(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
    } as Response;
  }) as unknown as typeof fetch;
  return { fetch, calls };
}

function memoryStorage(): PocketStorage {
  const passkeys = new Map<string, string>();
  const paired = new Set<string>();
  return {
    getPasskeyPublicKey: (id) => passkeys.get(id) ?? null,
    setPasskeyPublicKey: (id, pk) => void passkeys.set(id, pk),
    isPaired: (hostId) => paired.has(hostId),
    markPaired: (hostId) => void paired.add(hostId),
  };
}

class FakeSocket implements PocketSocket {
  readyState = 0;
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

  /** Simulate the server/network dropping the connection (no client `close()`). */
  drop(): void {
    this.readyState = 3;
    this.#emit('close', { code: 1006 });
  }

  fireOpen(): void {
    this.readyState = 1;
    this.#emit('open', {});
  }

  /** Simulate the server sending a frame to this client. */
  server(frame: unknown): void {
    this.#emit('message', { data: JSON.stringify(frame) });
  }

  #emit(type: string, ev: unknown): void {
    for (const handler of this.#handlers.get(type) ?? []) handler(ev);
  }
}

/** Poll `sent` for the first frame matching `predicate`. */
async function nextSent(
  socket: FakeSocket,
  predicate: (frame: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i++) {
    const found = socket.sent.find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('expected frame was never sent');
}

interface Harness {
  client: PocketClient;
  socket: FakeSocket;
  calls: FetchCall[];
  device: () => Promise<DeviceKeyPair>;
}

function makeClient(
  routes: Record<string, (body: unknown) => { status?: number; json: unknown }>,
  overrides: Partial<PocketClientDeps> = {},
): Harness {
  const socket = new FakeSocket();
  const { fetch, calls } = makeFetch(routes);
  let devicePair: DeviceKeyPair | undefined;
  const device = async () => (devicePair ??= await generateDeviceKeyPair());
  const client = new PocketClient({
    wsBase: 'ws://test',
    fetch,
    webauthn: fakeWebAuthn,
    createWebSocket: () => socket,
    deviceKey: device,
    storage: memoryStorage(),
    ...overrides,
  });
  return { client, socket, calls, device };
}

const AUTH_ROUTES = {
  '/api/setup/begin': () => ({
    json: { challenge: b64uChallenge(1), rpId: RP_ID, accountId: SELFHOST_ACCOUNT_ID },
  }),
  '/api/setup/finish': () => ({
    json: { accountId: SELFHOST_ACCOUNT_ID, credentialId: CREDENTIAL_ID },
  }),
  '/api/signin/begin': () => ({ json: { challenge: b64uChallenge(9), rpId: RP_ID } }),
  '/api/signin/finish': () => ({
    json: { sessionToken: 'tok-abc', accountId: SELFHOST_ACCOUNT_ID, expiresAt: 1 },
  }),
  '/api/hosts': () => ({ json: { hosts: [{ hostId: 'h1', label: 'Laptop', online: true }] } }),
} as const;

/** Setup + sign-in + open the relay socket, ready for pair/connect. */
async function signedIn(overrides: Partial<PocketClientDeps> = {}): Promise<Harness> {
  const harness = makeClient({ ...AUTH_ROUTES }, overrides);
  await harness.client.setup('pw', 'My Phone');
  await harness.client.signin();
  const open = harness.client.openSocket();
  harness.socket.fireOpen();
  await open;
  return harness;
}

// --- Tests -----------------------------------------------------------------

describe('setup + signin', () => {
  it('registers, signs in, keeps the token, and sends it as a bearer', async () => {
    const harness = makeClient({ ...AUTH_ROUTES });
    const setup = await harness.client.setup('pw', 'My Phone');
    expect(setup.credentialId).toBe(CREDENTIAL_ID);

    const signin = await harness.client.signin();
    expect(signin.sessionToken).toBe('tok-abc');
    expect(harness.client.sessionToken).toBe('tok-abc');

    const hosts = await harness.client.listHosts();
    expect(hosts).toEqual([{ hostId: 'h1', label: 'Laptop', online: true }]);
    const hostsCall = harness.calls.find((c) => c.url.endsWith('/api/hosts'))!;
    expect(hostsCall.method).toBe('GET');
    expect(hostsCall.headers.authorization).toBe('Bearer tok-abc');
  });

  it('rejects with the server error message on a failed request', async () => {
    const harness = makeClient({
      '/api/setup/begin': () => ({ status: 401, json: { error: 'invalid setup password' } }),
    });
    await expect(harness.client.setup('wrong', 'Phone')).rejects.toThrow('invalid setup password');
  });
});

describe('pair', () => {
  it('sends a well-formed pairing frame and resolves on pair-result', async () => {
    const { client, socket } = await signedIn();
    const pairing = client.pair('h1', 'iPhone Safari');

    const frame = await nextSent(socket, (f) => f.t === 'pair');
    expect(frame.hostId).toBe('h1');
    const request = frame.request as Record<string, unknown>;
    expect(request.accountId).toBe(SELFHOST_ACCOUNT_ID);
    expect(request.passkeyCredentialId).toBe(CREDENTIAL_ID);
    expect(request.passkeyPublicKeyHash).toBe(await hashPasskeyPublicKey(PASSKEY_PUBLIC_KEY));
    expect(request.requestedLabel).toBe('iPhone Safari');
    expect(typeof request.devicePublicKey).toBe('string');

    const record = { hostId: 'h1', label: 'iPhone Safari' };
    socket.server({ t: 'pair-result', approved: true, record });
    const result = await pairing;
    expect(result.approved).toBe(true);
    expect(result.record).toEqual(record);
    expect(client.isPaired('h1')).toBe(true);
  });

  it('surfaces a denial and does not mark the host paired', async () => {
    const { client, socket } = await signedIn();
    const pairing = client.pair('h1', 'iPhone');
    await nextSent(socket, (f) => f.t === 'pair');
    socket.server({ t: 'pair-result', approved: false, error: 'denied by host' });
    const result = await pairing;
    expect(result.approved).toBe(false);
    expect(result.error).toBe('denied by host');
    expect(client.isPaired('h1')).toBe(false);
  });
});

describe('connect', () => {
  it('challenge → one assertion + device signature → connect2 → allowed', async () => {
    const { client, socket, device } = await signedIn();
    const connecting = client.connect('h1');

    await nextSent(socket, (f) => f.t === 'connect');
    socket.server({ t: 'challenge', hostId: 'h1', challenge: b64uChallenge(7), expiresAt: 9e15 });

    const connect2 = await nextSent(socket, (f) => f.t === 'connect2');
    const request = connect2.request as Record<string, unknown>;
    expect(request.accountId).toBe(SELFHOST_ACCOUNT_ID);
    expect(request.challenge).toBe(b64uChallenge(7));
    expect(request.devicePublicKey).toBe((await device()).devicePublicKey);
    expect(typeof request.deviceSignature).toBe('string');
    expect((request.passkey as Record<string, unknown>).publicKey).toBe(PASSKEY_PUBLIC_KEY);
    expect((request.passkey as { assertion: PasskeyAssertion }).assertion.credentialId).toBe(
      CREDENTIAL_ID,
    );

    socket.server({ t: 'decision', allowed: true });
    const decision = await connecting;
    expect(decision.allowed).toBe(true);
    expect(client.connectedHostId).toBe('h1');
  });

  it('resolves not-allowed with failures on a denied decision', async () => {
    const { client, socket } = await signedIn();
    const connecting = client.connect('h1');
    await nextSent(socket, (f) => f.t === 'connect');
    socket.server({ t: 'challenge', hostId: 'h1', challenge: b64uChallenge(3), expiresAt: 9e15 });
    await nextSent(socket, (f) => f.t === 'connect2');
    socket.server({ t: 'decision', allowed: false, failures: ['device-not-paired'] });
    const decision = await connecting;
    expect(decision.allowed).toBe(false);
    expect(decision.failures).toEqual(['device-not-paired']);
    expect(client.connectedHostId).toBeNull();
  });
});

/** Drive the full connect dance until the session is established. */
async function connectEstablished(harness: Harness): Promise<void> {
  const { client, socket } = harness;
  const connecting = client.connect('h1');
  await nextSent(socket, (f) => f.t === 'connect');
  socket.server({ t: 'challenge', hostId: 'h1', challenge: b64uChallenge(7), expiresAt: 9e15 });
  await nextSent(socket, (f) => f.t === 'connect2');
  socket.server({ t: 'decision', allowed: true });
  await connecting;
}

describe('socket lifecycle', () => {
  it('an unexpected close fires host-gone for an established session and resets the socket', async () => {
    const harness = await signedIn();
    await connectEstablished(harness);
    let hostGone = 0;
    harness.client.setOnHostGone(() => hostGone++);

    harness.socket.drop();
    expect(hostGone).toBe(1);
    expect(harness.client.socketOpen).toBe(false);
    expect(harness.client.connectedHostId).toBeNull();
  });

  it('an intentional close() does not fire host-gone', async () => {
    const harness = await signedIn();
    await connectEstablished(harness);
    let hostGone = 0;
    harness.client.setOnHostGone(() => hostGone++);

    harness.client.close();
    expect(hostGone).toBe(0);
    expect(harness.client.socketOpen).toBe(false);
  });

  it('a host-gone frame followed by a socket close fires host-gone exactly once', async () => {
    const harness = await signedIn();
    await connectEstablished(harness);
    let hostGone = 0;
    harness.client.setOnHostGone(() => hostGone++);

    harness.socket.server({ t: 'host-gone' });
    expect(hostGone).toBe(1);
    expect(harness.client.connectedHostId).toBeNull();
    harness.socket.drop();
    expect(hostGone).toBe(1);
  });

  it('an unexpected close without an established session resets state silently', async () => {
    const harness = await signedIn();
    let hostGone = 0;
    harness.client.setOnHostGone(() => hostGone++);

    harness.socket.drop();
    expect(hostGone).toBe(0);
    expect(harness.client.socketOpen).toBe(false);
  });
});

describe('remote-api correlation', () => {
  it('resolves a request by requestId', async () => {
    const { client, socket } = await signedIn();
    const helloing = client.hello();
    const frame = await nextSent(socket, (f) => f.t === 'msg');
    const data = frame.data as { requestId: string; method: string };
    expect(data.method).toBe('hello');
    socket.server({
      t: 'msg',
      data: { requestId: data.requestId, ok: true, result: { protocolVersion: 1, hostId: 'h1' } },
    });
    const result = await helloing;
    expect(result.hostId).toBe('h1');
  });

  it('rejects a request when the response is ok:false', async () => {
    const { client, socket } = await signedIn();
    const req = client.request('bogus');
    const frame = await nextSent(socket, (f) => f.t === 'msg');
    const data = frame.data as { requestId: string };
    socket.server({ t: 'msg', data: { requestId: data.requestId, ok: false, error: 'nope' } });
    await expect(req).rejects.toThrow('nope');
  });

  it('routes events by subId, and only to the matching subscription', async () => {
    const { client, socket } = await signedIn();
    const snapshots: unknown[] = [];
    const watching = client.watchDirectory((entries) => snapshots.push(entries));

    const frame = await nextSent(socket, (f) => f.t === 'msg');
    const data = frame.data as { requestId: string; method: string };
    expect(data.method).toBe('directory.watch');
    // Host convention: the subId is the request's own requestId.
    socket.server({ t: 'msg', data: { requestId: data.requestId, ok: true, result: { subId: data.requestId } } });
    const subId = await watching;
    expect(subId).toBe(data.requestId);

    // A snapshot for our subId is delivered...
    socket.server({
      t: 'msg',
      data: { subId, event: 'directory.snapshot', data: { entries: [{ title: 'zsh' }] } },
    });
    // ...one for an unrelated subId is not.
    socket.server({
      t: 'msg',
      data: { subId: 'other', event: 'directory.snapshot', data: { entries: [{ title: 'nope' }] } },
    });
    expect(snapshots).toEqual([[{ title: 'zsh' }]]);
  });
});

describe('getOrCreateDeviceKey (injected store)', () => {
  it('generates and persists on first call, then reuses', async () => {
    let stored: DeviceKeyPair | null = null;
    let puts = 0;
    const store: DeviceKeyStore = {
      get: async () => stored,
      put: async (key) => {
        stored = key;
        puts++;
      },
    };
    const first = await getOrCreateDeviceKey(store);
    expect(puts).toBe(1);
    const second = await getOrCreateDeviceKey(store);
    expect(puts).toBe(1);
    expect(second.devicePublicKey).toBe(first.devicePublicKey);
  });
});
