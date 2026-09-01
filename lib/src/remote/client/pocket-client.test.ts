/**
 * Pocket protocol-client coverage with faked fetch / WebAuthn / WebSocket, plus
 * the injected-store device-key logic. Everything crypto-touching
 * (`generateDeviceKeyPair`, `signDeviceChallenge`, `hashPasskeyPublicKey`) runs
 * for real against Node's WebCrypto; only the browser/network edges are faked.
 *
 * (fake-indexeddb is not a dependency, so the IndexedDB round-trip itself is not
 * exercised here — `getOrCreateDeviceKey` is tested through an injected store.)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PAIRING_STALE_PRESENCE_ERROR,
  SELFHOST_ACCOUNT_ID,
  SETUP_TOKEN_INVALID_ERROR,
  computeSetupProof,
  generateDeviceKeyPair,
  hashPasskeyPublicKey,
  pushEndpointFingerprint,
  toBase64Url,
  type DeviceKeyPair,
  type PasskeyAssertion,
} from 'server-lib-common';

import {
  hasRecoverablePairingFailure,
  localStoragePocketStorage,
  PASSKEY_UNAVAILABLE_MESSAGE,
  PocketClient,
  SessionExpiredError,
  SetupTokenInvalidError,
  type PocketStorage,
  type PocketClientDeps,
} from './pocket-client';
import { FakeSocket } from '../test-fake-socket';
import { getOrCreateDeviceKey, type DeviceKeyStore } from './device-key';
import type { PasskeyRegistration, WebAuthnClient } from './webauthn';

// --- Fakes -----------------------------------------------------------------

const CREDENTIAL_ID = 'cred-123';
const PASSKEY_PUBLIC_KEY = 'pk-spki-b64u';
const RP_ID = 'localhost';

it('directs a missing passkey cache back through sign-in', () => {
  expect(PASSKEY_UNAVAILABLE_MESSAGE).toContain('Sign in again');
  expect(PASSKEY_UNAVAILABLE_MESSAGE).not.toContain('device that first created');
});

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
  let pushEndpoint: string | null = null;
  return {
    getPasskeyPublicKey: (id) => passkeys.get(id) ?? null,
    setPasskeyPublicKey: (id, pk) => void passkeys.set(id, pk),
    knownCredentialIds: () => [...passkeys.keys()],
    isPaired: (hostId) => paired.has(hostId),
    markPaired: (hostId) => void paired.add(hostId),
    unmarkPaired: (hostId) => void paired.delete(hostId),
    getRegisteredPushEndpoint: () => pushEndpoint,
    setRegisteredPushEndpoint: (fingerprint) => void (pushEndpoint = fingerprint),
  };
}

/**
 * A {@link WebAuthnClient} that records the `allowCredentials` each
 * `getAssertion` is scoped to, so tests can assert connect narrows selection.
 */
function recordingWebAuthn(): {
  webauthn: WebAuthnClient;
  assertionAllowLists: Array<readonly string[] | undefined>;
} {
  const assertionAllowLists: Array<readonly string[] | undefined> = [];
  return {
    assertionAllowLists,
    webauthn: {
      registerPasskey: fakeWebAuthn.registerPasskey,
      async getAssertion(_challenge, _rpId, allowCredentials): Promise<PasskeyAssertion> {
        assertionAllowLists.push(allowCredentials);
        return assertion;
      },
    },
  };
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
    json: {
      sessionToken: 'tok-abc',
      accountId: SELFHOST_ACCOUNT_ID,
      expiresAt: 1,
      passkeyPublicKey: PASSKEY_PUBLIC_KEY,
    },
  }),
  '/api/hosts': () => ({ json: { hosts: [{ hostId: 'h1', label: 'Laptop', online: true }] } }),
} as const;

/** Setup + sign-in + open the relay socket, ready for pair/connect. */
async function signedIn(overrides: Partial<PocketClientDeps> = {}): Promise<Harness> {
  const harness = makeClient({ ...AUTH_ROUTES }, overrides);
  await harness.client.setup({ password: 'pw' }, 'My Phone');
  await harness.client.signin();
  const open = harness.client.openSocket();
  harness.socket.open();
  await open;
  return harness;
}

async function pairApproved(client: PocketClient, socket: FakeSocket): Promise<void> {
  const pairing = client.pair('h1', 'iPhone');
  await nextSent(socket, (f) => f.t === 'pair');
  socket.receive({ t: 'pair-result', approved: true, record: { hostId: 'h1' } });
  await pairing;
}

// --- Tests -----------------------------------------------------------------

describe('setup + signin', () => {
  it('registers, signs in, keeps the token, and sends it as a bearer', async () => {
    const harness = makeClient({ ...AUTH_ROUTES });
    const setup = await harness.client.setup({ password: 'pw' }, 'My Phone');
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

  /**
   * The account-centric half of the model: a synced passkey is enough to pair
   * from a browser profile that never performed the registration — an iOS Home
   * Screen install, a second browser — because sign-in returns the asserted
   * passkey's public key. Before this, only the registering profile could build
   * a pairing request, which forced a redundant second passkey per install.
   *
   * The device-centric half is untouched: this Client still needs its own
   * approval on the Host before it reaches anything.
   */
  it('can pair after signing in on a profile that never registered', async () => {
    const harness = makeClient({ ...AUTH_ROUTES });
    // No setup() — this profile's storage starts empty, as a fresh install's does.
    await harness.client.signin();

    const open = harness.client.openSocket();
    harness.socket.open();
    await open;

    const pairing = harness.client.pair('h1', 'iPhone (Home Screen)');
    const frame = await nextSent(harness.socket, (f) => f.t === 'pair');
    harness.socket.receive({ t: 'pair-result', approved: true, record: { hostId: 'h1' } });
    await pairing;

    // The request carries the hash of the key sign-in handed back.
    const request = (frame as { request: { passkeyPublicKeyHash: string } }).request;
    expect(request.passkeyPublicKeyHash).toBe(await hashPasskeyPublicKey(PASSKEY_PUBLIC_KEY));
  });

  it('rejects with the server error message on a failed request', async () => {
    const harness = makeClient({
      '/api/setup/begin': () => ({ status: 401, json: { error: 'invalid setup password' } }),
    });
    const failed = harness.client.setup({ password: 'wrong' }, 'Phone');

    await expect(failed).rejects.toThrow('invalid setup password');
    // An ordinary failure, not a dead code: this 401 answers a wrong password,
    // and the drop-the-code recovery keys on the body rather than the status.
    await expect(failed).rejects.not.toBeInstanceOf(SetupTokenInvalidError);
  });

  /**
   * Exactly one credential per request, on both routes: presenting the password
   * *and* a token is a 400, since trying the two in turn would let a spent
   * token fall through to the password (`docs/specs/server.md` -> Setup tokens).
   */
  it.each([
    ['the setup password', { password: 'pw' } as const, 'password', 'setupToken'],
    ['a scanned setup token', { setupToken: 'tok-qr' } as const, 'setupToken', 'password'],
  ])('sends %s alone, on begin and finish', async (_case, credential, sent, absent) => {
    const harness = makeClient({ ...AUTH_ROUTES });

    await harness.client.setup(credential, 'My Phone');

    for (const route of ['/api/setup/begin', '/api/setup/finish']) {
      const body = harness.calls.find((c) => c.url.endsWith(route))!.body as Record<string, unknown>;
      expect(body[sent]).toBe(Object.values(credential)[0]);
      expect(body).not.toHaveProperty(absent);
    }
    const finish = harness.calls.find((c) => c.url.endsWith('/api/setup/finish'))!.body as Record<
      string,
      unknown
    >;
    expect(finish.credentialId).toBe(CREDENTIAL_ID);
    expect(finish.label).toBe('My Phone');
  });

  /**
   * Its own error class, because Pocket has to react rather than report: a
   * spent code means "re-scan or type the password", where the shared
   * `UNAUTHORIZED_ERROR` would drive the sign-in recovery instead.
   */
  it('raises a distinct error for a dead setup token, on either setup route', async () => {
    const dead = { status: 401, json: { error: SETUP_TOKEN_INVALID_ERROR } };
    const atBegin = makeClient({ '/api/setup/begin': () => dead });
    await expect(atBegin.client.setup({ setupToken: 'spent' }, 'Phone')).rejects.toThrow(
      SetupTokenInvalidError,
    );

    const atFinish = makeClient({ ...AUTH_ROUTES, '/api/setup/finish': () => dead });
    await expect(atFinish.client.setup({ setupToken: 'spent' }, 'Phone')).rejects.toThrow(
      SetupTokenInvalidError,
    );
  });
});

describe('subscribeToPush', () => {
  const SUBSCRIPTION = {
    endpoint: 'https://push.example/original',
    keys: { p256dh: 'p256dh', auth: 'auth' },
  };
  const PUSH_ROUTES = {
    ...AUTH_ROUTES,
    '/api/push/challenge': () => ({ json: { challenge: b64uChallenge(3), expiresAt: 1 } }),
    '/api/push/subscribe': () => ({ json: { subscribedAt: 1, hostIds: ['h1'] } }),
  };

  /**
   * A push service may rotate an endpoint on its own, with the VAPID key
   * unchanged, which leaves every stored row pointing somewhere unreachable
   * while the browser still reports a valid subscription. Recording what was
   * registered is the only way the next app open can notice.
   */
  it('records the registered delivery address so a later rotation is detectable', async () => {
    const harness = makeClient(PUSH_ROUTES);
    await harness.client.setup({ password: 'pw' }, 'My Phone');
    await harness.client.signin();
    expect(harness.client.registeredPushEndpoint()).toBeNull();

    await harness.client.subscribeToPush('h1', SUBSCRIPTION);

    expect(harness.client.registeredPushEndpoint()).toBe(
      await pushEndpointFingerprint(SUBSCRIPTION.endpoint),
    );
    // A digest, not the address itself — the endpoint is a bearer capability and
    // equality is all the check needs.
    expect(harness.client.registeredPushEndpoint()).not.toContain('push.example');
  });

  it('records nothing when the Server rejected the registration', async () => {
    const harness = makeClient({
      ...PUSH_ROUTES,
      '/api/push/subscribe': () => ({ status: 401, json: { error: 'device signature rejected' } }),
    });
    await harness.client.setup({ password: 'pw' }, 'My Phone');
    await harness.client.signin();

    await expect(harness.client.subscribeToPush('h1', SUBSCRIPTION)).rejects.toThrow();
    expect(harness.client.registeredPushEndpoint()).toBeNull();
  });
});

describe('listPushSubscribedHosts', () => {
  /**
   * The Server answers with the whole account's registrations, so the filter to
   * "this device" happens client-side — that is what keeps the API from being
   * an enumeration primitive over a `devicePublicKey` the caller does not hold.
   */
  it('keeps only the Hosts this device registered', async () => {
    const device = await generateDeviceKeyPair();
    const harness = makeClient(
      {
        ...AUTH_ROUTES,
        '/api/push/subscriptions': () => ({
          json: {
            subscriptions: [
              { hostId: 'h1', devicePublicKey: device.devicePublicKey, subscribedAt: 1 },
              { hostId: 'h2', devicePublicKey: 'some-other-device', subscribedAt: 2 },
              { hostId: 'h3', devicePublicKey: device.devicePublicKey, subscribedAt: 3 },
            ],
          },
        }),
      },
      { deviceKey: async () => device },
    );
    await harness.client.setup({ password: 'pw' }, 'My Phone');
    await harness.client.signin();

    expect(await harness.client.listPushSubscribedHosts()).toEqual(['h1', 'h3']);
    const call = harness.calls.find((c) => c.url.endsWith('/api/push/subscriptions'))!;
    expect(call.method).toBe('GET');
    expect(call.headers.authorization).toBe('Bearer tok-abc');
    // The device identity is never sent — the Server has no input to filter on.
    expect(call.body).toBeUndefined();
  });

  it('is empty when this device registered nothing', async () => {
    const harness = makeClient({
      ...AUTH_ROUTES,
      '/api/push/subscriptions': () => ({
        json: { subscriptions: [{ hostId: 'h1', devicePublicKey: 'other', subscribedAt: 1 }] },
      }),
    });
    await harness.client.setup({ password: 'pw' }, 'My Phone');
    await harness.client.signin();
    expect(await harness.client.listPushSubscribedHosts()).toEqual([]);
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
    socket.receive({ t: 'pair-result', approved: true, record });
    const result = await pairing;
    expect(result.approved).toBe(true);
    expect(result.record).toEqual(record);
    expect(client.isPaired('h1')).toBe(true);
  });

  /**
   * The nonce itself never leaves the phone — what rides is a MAC of it over
   * the device key this very request asks the Host to authorize, which is what
   * a relay cannot re-key onto a substituted one
   * (`docs/specs/remote-security-model.md` -> Pairing Ceremony).
   */
  it('proves the scanned nonce over the device key it is asking to authorize', async () => {
    const { client, socket, device } = await signedIn();
    const pairing = client.pair('h1', 'iPhone', 'nonce-from-the-qr');

    const frame = await nextSent(socket, (f) => f.t === 'pair');
    const request = frame.request as Record<string, unknown>;
    const { devicePublicKey } = await device();
    expect(request.devicePublicKey).toBe(devicePublicKey);
    expect(request.setupProof).toBe(
      await computeSetupProof('nonce-from-the-qr', devicePublicKey),
    );
    expect(JSON.stringify(request)).not.toContain('nonce-from-the-qr');

    socket.receive({ t: 'pair-result', approved: true, record: { hostId: 'h1' } });
    await pairing;
  });

  it('sends no proof once the nonce is spent', async () => {
    const { client, socket } = await signedIn();
    const pairing = client.pair('h1', 'iPhone', null);

    const frame = await nextSent(socket, (f) => f.t === 'pair');
    // Absent, not empty: the Host reads any non-string as no proof at all, and
    // an empty one could not be a MAC anyway.
    expect(frame.request as Record<string, unknown>).not.toHaveProperty('setupProof');

    socket.receive({ t: 'pair-result', approved: true, record: { hostId: 'h1' } });
    await pairing;
  });

  it('surfaces a denial and does not mark the host paired', async () => {
    const { client, socket } = await signedIn();
    const pairing = client.pair('h1', 'iPhone');
    await nextSent(socket, (f) => f.t === 'pair');
    socket.receive({ t: 'pair-result', approved: false, error: 'denied by host' });
    const result = await pairing;
    expect(result.approved).toBe(false);
    expect(result.error).toBe('denied by host');
    expect(client.isPaired('h1')).toBe(false);
  });

  it('re-asserts presence and retries once on a stale-presence denial', async () => {
    const harness = makeClient({
      ...AUTH_ROUTES,
      '/api/reauth/begin': () => ({ json: { challenge: b64uChallenge(7), rpId: RP_ID } }),
      '/api/reauth/finish': () => ({ json: { presenceVerifiedAt: 123 } }),
    });
    const { client, socket, calls } = harness;
    await client.setup({ password: 'pw' }, 'My Phone');
    await client.signin();
    const open = client.openSocket();
    socket.open();
    await open;

    const pairing = client.pair('h1', 'iPhone');
    await nextSent(socket, (f) => f.t === 'pair');
    socket.receive({ t: 'pair-result', approved: false, error: PAIRING_STALE_PRESENCE_ERROR });

    // The client re-auths (bearer-authorized begin + finish) and re-sends the
    // SAME pairing request; approve the retry.
    const retry = await (async () => {
      for (let i = 0; i < 200; i++) {
        const pairs = socket.sent.filter((f) => f.t === 'pair');
        if (pairs.length >= 2) return pairs[1]!;
        await new Promise((r) => setTimeout(r, 2));
      }
      throw new Error('no retry pair frame was sent');
    })();
    const first = socket.sent.find((f) => f.t === 'pair')!;
    expect(retry.request).toEqual(first.request);
    socket.receive({ t: 'pair-result', approved: true, record: { hostId: 'h1' } });

    const result = await pairing;
    expect(result.approved).toBe(true);
    expect(client.isPaired('h1')).toBe(true);
    for (const route of ['/api/reauth/begin', '/api/reauth/finish']) {
      const call = calls.find((c) => c.url.endsWith(route))!;
      expect(call.headers.authorization).toBe('Bearer tok-abc');
    }
  });
});

describe('queryPaired', () => {
  it('asks the Host with this Client identity and records a yes', async () => {
    const { client, socket, device } = await signedIn();
    expect(client.isPaired('h1')).toBe(false);

    const asking = client.queryPaired('h1');
    const frame = await nextSent(socket, (f) => f.t === 'pair-status');
    expect(frame.hostId).toBe('h1');
    const query = frame.query as Record<string, unknown>;
    // The ACL's lookup key, and nothing else: no assertion, no signature.
    expect(query.passkeyCredentialId).toBe(CREDENTIAL_ID);
    expect(query.devicePublicKey).toBe((await device()).devicePublicKey);

    socket.receive({ t: 'pair-status-result', hostId: 'h1', paired: true });
    expect(await asking).toBe(true);
    expect(client.isPaired('h1')).toBe(true);
  });

  /**
   * The marker is a cache of a past approval, and the Host can lose the record
   * behind it — an ACL reset, a hand-edited file. Converging on the Host's
   * answer is what stops the row offering a Connect that can only fail.
   */
  it('drops a marker the Host no longer backs', async () => {
    const { client, socket } = await signedIn();
    await pairApproved(client, socket);
    expect(client.isPaired('h1')).toBe(true);

    const asking = client.queryPaired('h1');
    await nextSent(socket, (f) => f.t === 'pair-status');
    socket.receive({ t: 'pair-status-result', hostId: 'h1', paired: false });

    expect(await asking).toBe(false);
    expect(client.isPaired('h1')).toBe(false);
  });

  it('settles each answer against the host it asked, whatever the order', async () => {
    const { client, socket } = await signedIn();
    const first = client.queryPaired('h1');
    const second = client.queryPaired('h2');
    await nextSent(socket, (f) => f.t === 'pair-status' && f.hostId === 'h2');

    // Answered out of order: keyed on the frame type alone, h2's answer would
    // settle h1's question and mark the wrong Host paired.
    socket.receive({ t: 'pair-status-result', hostId: 'h2', paired: true });
    socket.receive({ t: 'pair-status-result', hostId: 'h1', paired: false });

    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(client.isPaired('h1')).toBe(false);
    expect(client.isPaired('h2')).toBe(true);
  });

  it('joins overlapping asks about one Host into a single query', async () => {
    const { client, socket } = await signedIn();
    const first = client.queryPaired('h1');
    const second = client.queryPaired('h1');
    await nextSent(socket, (f) => f.t === 'pair-status');
    socket.receive({ t: 'pair-status-result', hostId: 'h1', paired: true });
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    // One frame for both callers: a joined ask must not re-send (the waiter
    // key is single-flight) or double-consume the relay's routing token.
    expect(socket.sent.filter((f) => f.t === 'pair-status')).toHaveLength(1);
  });

  /**
   * `connect` scopes its assertion to every credential this browser holds a
   * public key for, so the advisory ask covers the same set — asking only the
   * signed-in one would offer Pair on a row whose Connect would succeed
   * through an older credential.
   */
  it('asks about every known credential before concluding unpaired', async () => {
    const storage = memoryStorage();
    storage.setPasskeyPublicKey('cred-old', 'pk-old');
    const { client, socket } = await signedIn({ storage });

    const asking = client.queryPaired('h1');
    const first = await nextSent(socket, (f) => f.t === 'pair-status');
    expect((first.query as Record<string, unknown>).passkeyCredentialId).toBe(CREDENTIAL_ID);
    socket.receive({ t: 'pair-status-result', hostId: 'h1', paired: false });

    await nextSent(
      socket,
      (f) =>
        f.t === 'pair-status' &&
        (f.query as Record<string, unknown>).passkeyCredentialId === 'cred-old',
    );
    socket.receive({ t: 'pair-status-result', hostId: 'h1', paired: true });

    expect(await asking).toBe(true);
    expect(client.isPaired('h1')).toBe(true);
  });

  /**
   * A Host that predates the frame silently drops it, so the ask carries a
   * deadline: the waiter key must come back (a stranded key would throw
   * "already awaiting" on the next visit's ask) and the marker must survive as
   * the fallback the answer never overrode.
   */
  it('times out an unanswered ask, freeing the key and keeping the marker', async () => {
    // shouldAdvanceTime keeps nextSent's real 2ms polling alive while the 5s
    // deadline is jumped explicitly.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { client, socket } = await signedIn();
      await pairApproved(client, socket);

      const asking = client.queryPaired('h1');
      await nextSent(socket, (f) => f.t === 'pair-status');
      vi.advanceTimersByTime(5_000);
      await expect(asking).rejects.toThrow(/timed out/);
      expect(client.isPaired('h1')).toBe(true);

      // The key is free again, and an answer arriving while nothing awaits it
      // is dropped. (A late answer landing after a retry re-registers the key
      // WOULD settle the retry — the ask carries no per-attempt identity; see
      // the error-correlation follow-up.)
      socket.receive({ t: 'pair-status-result', hostId: 'h1', paired: false });
      const retry = client.queryPaired('h1');
      await nextSent(socket, (f) => f.t === 'pair-status');
      socket.receive({ t: 'pair-status-result', hostId: 'h1', paired: true });
      expect(await retry).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('connect', () => {
  it('classifies ACL miss failures as recoverable stale pairing', () => {
    expect(hasRecoverablePairingFailure(['device-not-paired'])).toBe(true);
    expect(hasRecoverablePairingFailure(['pairing-mismatch'])).toBe(true);
    expect(hasRecoverablePairingFailure(['passkey-not-paired'])).toBe(true);
    expect(hasRecoverablePairingFailure(['challenge-invalid'])).toBe(false);
    expect(hasRecoverablePairingFailure(undefined)).toBe(false);
  });

  it('challenge → one assertion + device signature → connect2 → allowed', async () => {
    const { client, socket, device } = await signedIn();
    const connecting = client.connect('h1');

    await nextSent(socket, (f) => f.t === 'connect');
    socket.receive({ t: 'challenge', hostId: 'h1', challenge: b64uChallenge(7), expiresAt: 9e15 });

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

    socket.receive({ t: 'decision', allowed: true });
    const decision = await connecting;
    expect(decision.allowed).toBe(true);
    expect(client.connectedHostId).toBe('h1');
  });

  it('scopes the connect assertion to the stored credential and resolves its public key', async () => {
    const { webauthn, assertionAllowLists } = recordingWebAuthn();
    const { client, socket } = await signedIn({ webauthn });

    const connecting = client.connect('h1');
    await nextSent(socket, (f) => f.t === 'connect');
    socket.receive({ t: 'challenge', hostId: 'h1', challenge: b64uChallenge(7), expiresAt: 9e15 });
    const connect2 = await nextSent(socket, (f) => f.t === 'connect2');
    socket.receive({ t: 'decision', allowed: true });

    const decision = await connecting;
    expect(decision.allowed).toBe(true);
    // sign-in discovers (empty list); connect scopes to the credential setup stored.
    expect(assertionAllowLists.at(-1)).toEqual([CREDENTIAL_ID]);
    // ...so the stored public key is the one placed into the connect2 request.
    const request = connect2.request as { passkey: { publicKey: string } };
    expect(request.passkey.publicKey).toBe(PASSKEY_PUBLIC_KEY);
  });

  it('rejects a second waiter for an already-pending frame type', async () => {
    const { client, socket } = await signedIn();
    const first = client.connect('h1');
    // Once the first connect is awaiting its challenge, a second overlapping
    // connect must not silently queue behind it.
    await nextSent(socket, (f) => f.t === 'connect');
    await expect(client.connect('h1')).rejects.toThrow(/already awaiting/);

    // The first handshake still completes normally.
    socket.receive({ t: 'challenge', hostId: 'h1', challenge: b64uChallenge(7), expiresAt: 9e15 });
    await nextSent(socket, (f) => f.t === 'connect2');
    socket.receive({ t: 'decision', allowed: true });
    expect((await first).allowed).toBe(true);
  });

  it('resolves not-allowed with failures on a denied decision', async () => {
    const { client, socket } = await signedIn();
    await pairApproved(client, socket);
    expect(client.isPaired('h1')).toBe(true);

    const connecting = client.connect('h1');
    await nextSent(socket, (f) => f.t === 'connect');
    socket.receive({ t: 'challenge', hostId: 'h1', challenge: b64uChallenge(3), expiresAt: 9e15 });
    await nextSent(socket, (f) => f.t === 'connect2');
    socket.receive({ t: 'decision', allowed: false, failures: ['device-not-paired'] });
    const decision = await connecting;
    expect(decision.allowed).toBe(false);
    expect(decision.failures).toEqual(['device-not-paired']);
    expect(decision.pairingStale).toBe(true);
    expect(client.isPaired('h1')).toBe(false);
    expect(client.connectedHostId).toBeNull();
  });

  it('keeps the paired marker for non-pairing denials', async () => {
    const { client, socket } = await signedIn();
    await pairApproved(client, socket);

    const connecting = client.connect('h1');
    await nextSent(socket, (f) => f.t === 'connect');
    socket.receive({ t: 'challenge', hostId: 'h1', challenge: b64uChallenge(4), expiresAt: 9e15 });
    await nextSent(socket, (f) => f.t === 'connect2');
    socket.receive({ t: 'decision', allowed: false, failures: ['challenge-invalid'] });

    const decision = await connecting;
    expect(decision.allowed).toBe(false);
    expect(decision.pairingStale).toBeUndefined();
    expect(client.isPaired('h1')).toBe(true);
  });
});

/** Drive the full connect dance until the session is established. */
async function connectEstablished(harness: Harness): Promise<void> {
  const { client, socket } = harness;
  const connecting = client.connect('h1');
  await nextSent(socket, (f) => f.t === 'connect');
  socket.receive({ t: 'challenge', hostId: 'h1', challenge: b64uChallenge(7), expiresAt: 9e15 });
  await nextSent(socket, (f) => f.t === 'connect2');
  socket.receive({ t: 'decision', allowed: true });
  await connecting;
}

describe('session expiry', () => {
  /** Signed in, with `/api/hosts` switchable between healthy and session-gate 401. */
  async function withHostsRoute(
    response: () => { status?: number; json: unknown },
  ): Promise<Harness> {
    const harness = makeClient({ ...AUTH_ROUTES, '/api/hosts': response });
    await harness.client.setup({ password: 'pw' }, 'My Phone');
    await harness.client.signin();
    return harness;
  }

  it('discards the token and reports expiry on the session gate 401', async () => {
    let live = true;
    const harness = await withHostsRoute(() =>
      live ? { json: { hosts: [] } } : { status: 401, json: { error: 'unauthorized' } },
    );
    expect(harness.client.sessionToken).toBe('tok-abc');

    live = false;
    await expect(harness.client.listHosts()).rejects.toBeInstanceOf(SessionExpiredError);
    // Keeping it would leave the UI believing it is still signed in.
    expect(harness.client.sessionToken).toBeNull();
  });

  // A wrong setup password and a rejected device signature also answer 401;
  // treating those as expiry would sign the user out mid-action.
  it('leaves a 401 that is not the session gate as an ordinary failure', async () => {
    const harness = await withHostsRoute(() => ({
      status: 401,
      json: { error: 'device signature rejected' },
    }));

    await expect(harness.client.listHosts()).rejects.toThrow('device signature rejected');
    expect(harness.client.sessionToken).toBe('tok-abc');
  });

  it('turns a rejected relay upgrade into expiry when the session is the reason', async () => {
    let live = true;
    const harness = await withHostsRoute(() =>
      live ? { json: { hosts: [] } } : { status: 401, json: { error: 'unauthorized' } },
    );

    live = false;
    const opening = harness.client.openSocket();
    harness.socket.emitError();
    await expect(opening).rejects.toBeInstanceOf(SessionExpiredError);
    expect(harness.client.sessionToken).toBeNull();
  });

  it('keeps a socket failure a socket failure while the session is alive', async () => {
    const harness = await withHostsRoute(() => ({ json: { hosts: [] } }));

    const opening = harness.client.openSocket();
    harness.socket.emitError();
    await expect(opening).rejects.toThrow('relay socket error');
    expect(harness.client.sessionToken).toBe('tok-abc');
  });
});

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

    harness.socket.receive({ t: 'host-gone' });
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

  it('ignores host-gone and close events from a stale socket after reconnecting', async () => {
    const sockets = [new FakeSocket(), new FakeSocket()];
    const harness = makeClient(
      { ...AUTH_ROUTES },
      { createWebSocket: () => sockets.shift() ?? new FakeSocket() },
    );
    const first = sockets[0]!;
    const second = sockets[1]!;

    await harness.client.setup({ password: 'pw' }, 'My Phone');
    await harness.client.signin();

    const firstOpen = harness.client.openSocket();
    first.open();
    await firstOpen;
    await connectEstablished({ ...harness, socket: first });

    first.closeEmits = false;
    harness.client.close();

    const secondOpen = harness.client.openSocket();
    second.open();
    await secondOpen;
    await connectEstablished({ ...harness, socket: second });

    let hostGone = 0;
    harness.client.setOnHostGone(() => hostGone++);

    first.receive({ t: 'host-gone' });
    expect(hostGone).toBe(0);
    expect(harness.client.connectedHostId).toBe('h1');
    expect(harness.client.socketOpen).toBe(true);

    first.closeWith(1000);
    expect(hostGone).toBe(0);
    expect(harness.client.connectedHostId).toBe('h1');
    expect(harness.client.socketOpen).toBe(true);
  });
});

describe('remote-api correlation', () => {
  it('resolves a request by requestId', async () => {
    const { client, socket } = await signedIn();
    const helloing = client.hello();
    const frame = await nextSent(socket, (f) => f.t === 'msg');
    const data = frame.data as { requestId: string; method: string };
    expect(data.method).toBe('hello');
    socket.receive({
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
    socket.receive({ t: 'msg', data: { requestId: data.requestId, ok: false, error: 'nope' } });
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
    socket.receive({ t: 'msg', data: { requestId: data.requestId, ok: true, result: { subId: data.requestId } } });
    const subId = await watching;
    expect(subId).toBe(data.requestId);

    // A snapshot for our subId is delivered...
    socket.receive({
      t: 'msg',
      data: { subId, event: 'directory.snapshot', data: { entries: [{ title: 'zsh' }] } },
    });
    // ...one for an unrelated subId is not.
    socket.receive({
      t: 'msg',
      data: { subId: 'other', event: 'directory.snapshot', data: { entries: [{ title: 'nope' }] } },
    });
    expect(snapshots).toEqual([[{ title: 'zsh' }]]);
  });
});

describe('hasPriorUse', () => {
  it('is false on a browser that has stored nothing', () => {
    const { client } = makeClient({});

    expect(client.hasPriorUse()).toBe(false);
  });

  it('is true once a credential public key is cached', async () => {
    const { client } = makeClient({ ...AUTH_ROUTES });
    await client.setup({ password: 'pw' }, 'My Phone');

    expect(client.hasPriorUse()).toBe(true);
  });

  /**
   * The auth screen picks its layout from this, so a storage that throws must
   * not take the screen down with it — and "first visit" is the safe reading,
   * because setup is the half that can still get somewhere from nothing.
   */
  it('reads a throwing store as a first visit', () => {
    const storage: PocketStorage = {
      ...memoryStorage(),
      knownCredentialIds: () => {
        throw new Error('site data blocked');
      },
    };
    const { client } = makeClient({}, { storage });

    expect(client.hasPriorUse()).toBe(false);
  });
});

describe('localStoragePocketStorage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A `localStorage` that throws on every access, as blocked site data does. */
  function blockedLocalStorage() {
    const blocked = (): never => {
      throw new Error('The operation is insecure.');
    };
    return {
      getItem: blocked,
      setItem: blocked,
      removeItem: blocked,
      key: blocked,
      clear: blocked,
      get length(): number {
        return blocked();
      },
    };
  }

  /** A working `localStorage`, to prove the mirror did not replace persistence. */
  function fakeLocalStorage() {
    const map = new Map<string, string>();
    return {
      map,
      store: {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => void map.set(key, value),
        removeItem: (key: string) => void map.delete(key),
        key: (i: number) => [...map.keys()][i] ?? null,
        clear: () => map.clear(),
        get length() {
          return map.size;
        },
      },
    };
  }

  /**
   * `setup` commits the Server's passkey *before* caching its public key, so a
   * write that throws here would strand the visit past the point of no return —
   * and every retry would mint another orphan passkey server-side.
   */
  it('does not throw on any write when storage is blocked', () => {
    vi.stubGlobal('localStorage', blockedLocalStorage());
    const storage = localStoragePocketStorage();

    expect(() => {
      storage.setPasskeyPublicKey('cred-1', 'pk-1');
      storage.markPaired('h1');
      storage.unmarkPaired('h2');
      storage.setRegisteredPushEndpoint('digest');
    }).not.toThrow();
  });

  it('answers reads from the in-session mirror when storage is blocked', () => {
    vi.stubGlobal('localStorage', blockedLocalStorage());
    const storage = localStoragePocketStorage();

    storage.setPasskeyPublicKey('cred-1', 'pk-1');
    storage.markPaired('h1');
    storage.setRegisteredPushEndpoint('digest');

    // Everything setup and sign-in need is still here; only surviving a reload
    // was lost.
    expect(storage.getPasskeyPublicKey('cred-1')).toBe('pk-1');
    expect(storage.knownCredentialIds()).toEqual(['cred-1']);
    expect(storage.isPaired('h1')).toBe(true);
    expect(storage.getRegisteredPushEndpoint()).toBe('digest');
    // Nothing was invented for what was never written.
    expect(storage.getPasskeyPublicKey('cred-other')).toBeNull();
    expect(storage.isPaired('h2')).toBe(false);
  });

  it('still writes through to storage when it works, and unions both on read', () => {
    const { map, store } = fakeLocalStorage();
    map.set('dormouse-pocket:passkey:cred-old', 'pk-old');
    vi.stubGlobal('localStorage', store);
    const storage = localStoragePocketStorage();

    storage.setPasskeyPublicKey('cred-new', 'pk-new');

    expect(map.get('dormouse-pocket:passkey:cred-new')).toBe('pk-new');
    // `connect` scopes its assertion to this set, so an earlier visit's
    // credential must not fall out of it.
    expect([...storage.knownCredentialIds()].sort()).toEqual(['cred-new', 'cred-old']);
  });

  it('honors an unpair the mirror recorded but storage kept', () => {
    const { map, store } = fakeLocalStorage();
    map.set('dormouse-pocket:paired:h1', '1');
    vi.stubGlobal('localStorage', store);
    // removeItem throws (an unpair that cannot be persisted), reads still work.
    store.removeItem = () => {
      throw new Error('The operation is insecure.');
    };
    const storage = localStoragePocketStorage();

    expect(storage.isPaired('h1')).toBe(true);
    storage.unmarkPaired('h1');

    // The row must not keep offering Connect for a pairing the Host dropped.
    expect(storage.isPaired('h1')).toBe(false);
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
