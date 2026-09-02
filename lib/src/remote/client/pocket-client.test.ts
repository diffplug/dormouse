/**
 * The Pocket client's two end-to-end ceremonies, driven against the **real**
 * `RemoteHost` through an in-memory relay (`../test-relay.ts`).
 *
 * **No ceremony step is stubbed.** The Noise handshakes are the shipped suite,
 * the presence proofs are real ES256 assertions over the shared challenge
 * builder — verified by the same `verifyPresenceProof` a Host runs — and the
 * outcomes are decrypted on the session that produced them. Only the browser
 * and network edges are faked: `fetch`, `WebSocket`, WebAuthn's two calls, and
 * the two IndexedDB stores.
 *
 * The account-plane half (setup, sign-in, session expiry, push) drives a mocked
 * `fetch` alone; the relay is not involved in any of it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PAIRING_TTL_MS,
  E2E_KEEPALIVE_INTERVAL_MS,
  KEEPALIVE_BODY_SIZE,
  SELFHOST_ACCOUNT_ID,
  SETUP_TOKEN_INVALID_ERROR,
  formatPairingInvitationUrl,
  fromBase64Url,
  generateNoiseKeyPair,
  hashPasskeyPublicKey,
  mintNoiseStaticKeyPair,
  parsePairingInvitationUrl,
  presenceChallenge,
  pushEndpointFingerprint,
  randomBase64Url,
  toBase64Url,
  type HostAclRecord,
  type NoiseStaticKeyMaterial,
  type PairingInvitation,
  type PasskeyAssertion,
  type PresenceBinding,
} from 'server-lib-common';

import {
  CONNECTION_DENIAL_MESSAGES,
  HOST_UNAVAILABLE_MESSAGE,
  HostIdentityMismatchError,
  PAIRING_DENIAL_MESSAGES,
  PASSKEY_UNAVAILABLE_MESSAGE,
  PocketClient,
  SessionExpiredError,
  SetupTokenInvalidError,
  localStoragePocketStorage,
  purgeLegacyPairedMarkers,
  type PocketClientDeps,
  type PocketStorage,
} from './pocket-client';
import type {
  KnownHostStore,
  KnownHostV1,
  PendingDeletionStore,
  PendingDeliveryDeletionV1,
} from './pocket-db';
import { FakeSocket } from '../test-fake-socket';
import { createTestRelay, type TestRelay } from '../test-relay';
import { createTestAuthenticator, type TestAuthenticator } from '../test-e2e-client';
import { RemoteHost } from '../host/remote-host';
import type { HostEnrollment } from '../host/enrollment';
import type { PendingPairing } from '../host/pairing-approval';
import { PasskeyAlreadyRegisteredError, type WebAuthnClient } from './webauthn';

// --- Fakes -----------------------------------------------------------------

const ORIGIN = 'https://pocket.example';
const RP_ID = 'pocket.example';
const HOST_LABEL = 'Ned’s laptop';
const SESSION_TOKEN = 'tok-abc';

/** A base64url string usable where a real 32-byte secret goes. */
function secret(): string {
  return randomBase64Url(32);
}

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type RouteHandler = (
  body: unknown,
) => { status?: number; json?: unknown } | Promise<{ status?: number; json?: unknown }>;

/** A router-style fake `fetch` that records every call. */
function makeFetch(
  routes: Record<string, RouteHandler>,
  /** Answers a path no exact route claims; without one, an unknown path throws. */
  fallback?: (path: string, method: string) => { status?: number; json?: unknown } | undefined,
) {
  const calls: FetchCall[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'POST';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, headers, body });
    const path = new URL(url, 'http://test').pathname;
    const handler = routes[path];
    const answered = handler ? await handler(body) : fallback?.(path, method);
    if (!answered) throw new Error(`unexpected fetch: ${path}`);
    const { status = 200, json } = answered;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json ?? {},
    } as Response;
  }) as unknown as typeof fetch;
  return { fetch, calls };
}

function memoryStorage(): PocketStorage {
  const passkeys = new Map<string, string>();
  let pushEndpoint: string | null = null;
  return {
    getPasskeyPublicKey: (id) => passkeys.get(id) ?? null,
    setPasskeyPublicKey: (id, pk) => void passkeys.set(id, pk),
    forgetPasskeyPublicKey: (id) => void passkeys.delete(id),
    knownCredentialIds: () => [...passkeys.keys()],
    getRegisteredPushEndpoint: () => pushEndpoint,
    setRegisteredPushEndpoint: (fingerprint) => void (pushEndpoint = fingerprint),
  };
}

interface MemoryKnownHosts extends KnownHostStore {
  readonly records: Map<string, KnownHostV1>;
}

function memoryKnownHosts(): MemoryKnownHosts {
  const records = new Map<string, KnownHostV1>();
  return {
    records,
    get: async (hostId) => records.get(hostId) ?? null,
    put: async (record) => void records.set(record.hostId, record),
    delete: async (hostId) => void records.delete(hostId),
    list: async () => [...records.values()],
  };
}

/** The delivery id a paired record holds; throws if the record is not paired. */
function deliveryIdOf(store: MemoryKnownHosts, hostId: string): string {
  const authorization = store.records.get(hostId)?.authorization;
  if (authorization?.state !== 'paired') throw new Error(`${hostId} is not paired`);
  return authorization.deliveryId;
}

interface MemoryPendingDeletions extends PendingDeletionStore {
  readonly records: Map<string, PendingDeliveryDeletionV1>;
}

function memoryPendingDeletions(): MemoryPendingDeletions {
  const records = new Map<string, PendingDeliveryDeletionV1>();
  return {
    records,
    put: async (record) => void records.set(`${record.hostId}:${record.deliveryId}`, record),
    delete: async (hostId, deliveryId) => void records.delete(`${hostId}:${deliveryId}`),
    list: async () => [...records.values()],
  };
}

/**
 * A clock the test can make jump a full pairing TTL on every read, so the
 * deadline a ceremony sets is already due by the time its waiter is
 * registered. The alternative — waiting out a five-minute timer — is not a
 * test, and faking timers would fake the WebCrypto awaits with them.
 */
function expiringClock(): { now: () => number; expire: () => void } {
  let clock = 1_700_000_000_000;
  let jumping = false;
  return {
    now: () => {
      const now = clock;
      if (jumping) clock += DEFAULT_PAIRING_TTL_MS;
      return now;
    },
    expire: () => {
      jumping = true;
    },
  };
}

/** Poll until `predicate` holds, so a Host awaiting WebCrypto can catch up. */
async function waitFor(predicate: () => boolean, what = 'a condition'): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// --- The account-plane harness ---------------------------------------------

interface Harness {
  client: PocketClient;
  socket: FakeSocket;
  calls: FetchCall[];
  knownHosts: MemoryKnownHosts;
  pendingDeletions: MemoryPendingDeletions;
}

const CREDENTIAL_ID = 'cred-123';
const PASSKEY_PUBLIC_KEY = 'pk-spki-b64u';

const assertion: PasskeyAssertion = {
  credentialId: CREDENTIAL_ID,
  clientDataJSON: 'client-data',
  authenticatorData: 'auth-data',
  signature: 'sig',
};

const fakeWebAuthn: WebAuthnClient = {
  async registerPasskey() {
    return {
      credentialId: CREDENTIAL_ID,
      publicKey: PASSKEY_PUBLIC_KEY,
      clientDataJSON: 'create-client-data',
    };
  },
  async getAssertion() {
    return assertion;
  },
};

const AUTH_ROUTES: Record<string, RouteHandler> = {
  '/api/setup/begin': () => ({
    json: {
      challenge: secret(),
      rpId: RP_ID,
      accountId: SELFHOST_ACCOUNT_ID,
      existingCredentialIds: [],
    },
  }),
  '/api/setup/finish': () => ({
    json: { accountId: SELFHOST_ACCOUNT_ID, credentialId: CREDENTIAL_ID },
  }),
  '/api/setup/retire': () => ({ status: 204 }),
  '/api/signin/begin': () => ({ json: { challenge: secret(), rpId: RP_ID } }),
  '/api/signin/finish': () => ({
    json: {
      sessionToken: SESSION_TOKEN,
      accountId: SELFHOST_ACCOUNT_ID,
      expiresAt: 1,
      passkeyPublicKey: PASSKEY_PUBLIC_KEY,
    },
  }),
  '/api/hosts': () => ({ json: { hosts: [{ hostId: 'h1', label: 'Laptop', online: true }] } }),
};

function makeClient(
  routes: Record<string, RouteHandler>,
  overrides: Partial<PocketClientDeps> = {},
): Harness {
  const socket = new FakeSocket();
  const { fetch, calls } = makeFetch(routes);
  const knownHosts = memoryKnownHosts();
  const pendingDeletions = memoryPendingDeletions();
  const client = new PocketClient({
    wsBase: 'ws://test',
    fetch,
    webauthn: fakeWebAuthn,
    createWebSocket: () => socket,
    knownHosts,
    pendingDeletions,
    storage: memoryStorage(),
    ...overrides,
  });
  return { client, socket, calls, knownHosts, pendingDeletions };
}

/** A signed-in client on the account plane; no relay, no ceremony. */
async function signedIn(
  routes: Record<string, RouteHandler> = {},
  overrides: Partial<PocketClientDeps> = {},
): Promise<Harness> {
  const harness = makeClient({ ...AUTH_ROUTES, ...routes }, overrides);
  await harness.client.signin();
  return harness;
}

/** A `KnownHostV1` for the tests that need one without running a pairing. */
async function seedRecord(
  knownHosts: MemoryKnownHosts,
  hostId: string,
  overrides: Partial<KnownHostV1> = {},
): Promise<KnownHostV1> {
  const clientStatic = await generateNoiseKeyPair();
  const record: KnownHostV1 = {
    hostId,
    accountId: SELFHOST_ACCOUNT_ID,
    label: 'Laptop',
    hostStaticPublicKey: toBase64Url((await generateNoiseKeyPair()).publicKey),
    clientStaticKeyPair: {
      privateKey: clientStatic.privateKey as CryptoKey,
      publicKeyRaw: toBase64Url(clientStatic.publicKey),
    },
    passkeyCredentialId: CREDENTIAL_ID,
    passkeyPublicKeyHash: 'hash',
    authorization: { state: 'paired', deliveryId: `delivery-${hostId}`, approvedAt: 1 },
    ...overrides,
  };
  await knownHosts.put(record);
  return record;
}

// --- The end-to-end harness -------------------------------------------------

interface E2eHarness {
  client: PocketClient;
  host: RemoteHost;
  relay: TestRelay;
  hostId: string;
  authenticator: TestAuthenticator;
  noiseStatic: NoiseStaticKeyMaterial;
  knownHosts: MemoryKnownHosts;
  pendingDeletions: MemoryPendingDeletions;
  approvals: PendingPairing[];
  savedAcl: HostAclRecord[];
  calls: FetchCall[];
  /** The harness's own `fetch`, for a second client on the same fake Server. */
  fetch: typeof fetch;
  /** The Client's relay socket, once one is open — what a keepalive lands on. */
  clientSocket(): FakeSocket;
  /** One live invitation, as `setupQr` would mint it. */
  mintInvitation(): Promise<PairingInvitation>;
  /** Run a pairing and confirm it on the Host with the digits the phone showed. */
  pairAndApprove(
    invitation: PairingInvitation,
    options?: { code?: (shown: string) => string },
  ): Promise<Awaited<ReturnType<PocketClient['pair']>>>;
}

/**
 * A real Host, a real relay, and a real client — the whole loop in memory.
 *
 * `/api/reauth/*` is faked, but faithfully: `begin` derives the challenge from
 * the presented binding with the shared builder, exactly as the Server does, so
 * the assertion the authenticator produces is one `verifyPresenceProof`
 * accepts. Nothing else about the proof is simulated.
 */
async function makeE2eHarness(
  options: {
    hostId?: string;
    knownHosts?: MemoryKnownHosts;
    pendingDeletions?: MemoryPendingDeletions;
    authenticator?: TestAuthenticator;
    noiseStatic?: NoiseStaticKeyMaterial;
    /**
     * What the Host *announces* as its static, when that has to differ from the
     * key it actually handshakes with. Nothing on the Host validates this
     * string, so it is how a malformed pin reaches the Client at all.
     */
    announcedStatic?: string;
    loadAcl?: () => HostAclRecord[];
    now?: () => number;
    /** Make every delivery-row deletion fail, as an offline phone's would. */
    pushDeleteFails?: boolean;
    /** Extra `PocketClient` deps — the keepalive timer and visibility seams. */
    deps?: Partial<PocketClientDeps>;
  } = {},
): Promise<E2eHarness> {
  const hostId = options.hostId ?? randomBase64Url(16);
  const authenticator =
    options.authenticator ?? (await createTestAuthenticator({ rpId: RP_ID, origin: ORIGIN }));
  const noiseStatic = options.noiseStatic ?? (await mintNoiseStaticKeyPair());
  const knownHosts = options.knownHosts ?? memoryKnownHosts();
  const pendingDeletions = options.pendingDeletions ?? memoryPendingDeletions();
  const approvals: PendingPairing[] = [];
  let savedAcl: HostAclRecord[] = [];

  const enrollment: HostEnrollment = {
    serverUrl: ORIGIN,
    hostId,
    hostToken: 'host-tok',
    origin: ORIGIN,
    rpId: RP_ID,
    label: HOST_LABEL,
    noiseStaticPrivateKey: noiseStatic.privateKeyPkcs8,
    noiseStaticPublicKey: options.announcedStatic ?? noiseStatic.publicKey,
  };
  const hostSocket = new FakeSocket();
  const host = new RemoteHost({
    enrollment,
    reconnect: false,
    createWebSocket: () => hostSocket,
    loadAcl: options.loadAcl ?? (() => []),
    saveAcl: (_hostId, records) => {
      savedAcl = [...records];
    },
    requestApproval: (pending) => approvals.push(pending),
    dismissApproval: () => {},
    createSession: ({ send }) => ({
      // Enough protocol-v1 to prove the byte stream: every request is answered
      // with its own `requestId`, which is what `hello` correlates on.
      handle: (data) => {
        const request = data as { requestId?: unknown };
        if (typeof request.requestId !== 'string') return;
        send({
          requestId: request.requestId,
          ok: true,
          result: { protocolVersion: 1, hostId, grants: { input: true, layout: false } },
        });
      },
      dispose: () => {},
    }),
  });
  host.start();
  hostSocket.open();
  const relay = createTestRelay({ hostId, hostSocket });

  // The presence routes, derived exactly as the Server derives them.
  const nonces = new Map<string, PresenceBinding>();
  const routes: Record<string, RouteHandler> = {
    ...AUTH_ROUTES,
    // The account's real passkey, so the key the proof presents is the one the
    // authenticator actually signs with.
    '/api/signin/finish': () => ({
      json: {
        sessionToken: SESSION_TOKEN,
        accountId: SELFHOST_ACCOUNT_ID,
        expiresAt: 1,
        passkeyPublicKey: authenticator.publicKey,
      },
    }),
    '/api/reauth/begin': async (body) => {
      const binding = (body as { binding: PresenceBinding }).binding;
      const serverNonce = secret();
      nonces.set(serverNonce, binding);
      return {
        json: {
          challenge: await presenceChallenge(binding, serverNonce),
          rpId: RP_ID,
          serverNonce,
          allowCredentials: [binding.passkeyCredentialId],
        },
      };
    },
    '/api/reauth/finish': (body) => {
      const { serverNonce } = body as { serverNonce: string };
      if (!nonces.delete(serverNonce)) return { status: 400, json: { error: 'unknown nonce' } };
      return { json: { verifiedAt: 1 } };
    },
  };
  // The delivery ids a Host mints are random, so the deletion route is matched
  // by shape rather than by an exact path.
  const { fetch, calls } = makeFetch(routes, (path, method) => {
    if (method !== 'DELETE' || !path.startsWith('/api/push/subscriptions/')) return undefined;
    return options.pushDeleteFails ? { status: 503, json: { error: 'down' } } : { status: 204 };
  });

  const storage = memoryStorage();
  const webauthn: WebAuthnClient = {
    async registerPasskey() {
      return {
        credentialId: authenticator.credentialId,
        publicKey: authenticator.publicKey,
        clientDataJSON: 'create-client-data',
      };
    },
    // The real thing: a signature this Host's own verifier accepts.
    getAssertion: (challenge) => authenticator.assert(challenge, ORIGIN),
  };
  let clientSocket: FakeSocket | null = null;
  const client = new PocketClient({
    wsBase: 'ws://test',
    fetch,
    webauthn,
    createWebSocket: () => (clientSocket = relay.openClientSocket()),
    knownHosts,
    pendingDeletions,
    storage,
    ...(options.now ? { now: options.now } : {}),
    ...options.deps,
  });
  // Sign-in caches the asserted passkey's public key and names the credential
  // every presence proof is built from, exactly as it does in the app.
  await client.signin();

  return {
    client,
    host,
    relay,
    hostId,
    authenticator,
    noiseStatic,
    knownHosts,
    pendingDeletions,
    approvals,
    get savedAcl() {
      return savedAcl;
    },
    calls,
    fetch,
    clientSocket: () => {
      if (!clientSocket) throw new Error('the Client has not opened a relay socket');
      return clientSocket;
    },
    mintInvitation: () => host.mintInvitation(secret(), Date.now() + DEFAULT_PAIRING_TTL_MS),
    async pairAndApprove(invitation, { code } = {}) {
      // Counted from here: a harness that pairs twice must confirm the *new*
      // request rather than re-answering the one still in the log.
      const before = approvals.length;
      let shown: string | null = null;
      const pairing = client.pair(invitation, 'iPhone Safari', (value) => {
        shown = value;
      });
      await waitFor(() => approvals.length > before, 'the Host to surface an approval');
      const pending = approvals[approvals.length - 1]!;
      pending.approve(code ? code(shown!) : shown!);
      return await pairing;
    },
  };
}

// --- Pairing ----------------------------------------------------------------

describe('pairing, end to end', () => {
  it('scans, handshakes, proves presence, and pins the Host the laptop approved', async () => {
    const harness = await makeE2eHarness();
    const invitation = await harness.mintInvitation();

    let shown: string | null = null;
    const pairing = harness.client.pair(invitation, 'iPhone Safari', (code) => {
      shown = code;
    });

    // The digits are on screen while the outcome is still pending — the laptop's
    // modal tells the user to cancel if the phone shows none.
    await waitFor(() => shown !== null, 'the code to be shown');
    expect(shown).toMatch(/^[0-9]{2}$/);
    await waitFor(() => harness.approvals.length > 0, 'the approval modal');
    expect(harness.approvals[0]!.label).toBe('iPhone Safari');

    harness.approvals[0]!.approve(shown!);
    const result = await pairing;

    expect(result.ok).toBe(true);
    const record = harness.knownHosts.records.get(harness.hostId)!;
    expect(record.hostStaticPublicKey).toBe(harness.noiseStatic.publicKey);
    // The Host's own label reached the phone inside the encrypted outcome; the
    // Server never had it.
    expect(record.label).toBe(HOST_LABEL);
    expect(record.passkeyCredentialId).toBe(harness.authenticator.credentialId);
    expect(record.passkeyPublicKeyHash).toBe(
      await hashPasskeyPublicKey(harness.authenticator.publicKey),
    );
    expect(record.authorization).toEqual({
      state: 'paired',
      deliveryId: harness.savedAcl[0]!.deliveryId,
      approvedAt: expect.any(Number),
    });
    // The Host authorized the static this handshake authenticated, not one the
    // payload claimed.
    expect(harness.savedAcl[0]!.clientStaticPublicKey).toBe(record.clientStaticKeyPair.publicKeyRaw);
  });

  it('takes the invitation straight off the URL the Host renders', async () => {
    // The whole path a scan travels: the Host composes, the parser answers, and
    // the invitation it produced completes a real handshake.
    const harness = await makeE2eHarness();
    const minted = await harness.mintInvitation();
    const parsed = await parsePairingInvitationUrl(
      formatPairingInvitationUrl(ORIGIN, minted),
      ORIGIN,
    );
    expect(parsed).not.toBeNull();

    const result = await harness.pairAndApprove(parsed!);

    expect(result.ok).toBe(true);
  });

  it('reports the typed digits not matching as fixed copy, and stores nothing', async () => {
    const harness = await makeE2eHarness();
    const invitation = await harness.mintInvitation();

    // One attempt, and it is wrong: a two-digit secret with retries is not one.
    const result = await harness.pairAndApprove(invitation, {
      code: (shown) => (shown === '00' ? '01' : '00'),
    });

    expect(result).toEqual({
      ok: false,
      message: PAIRING_DENIAL_MESSAGES['confirmation-mismatch'],
    });
    expect(harness.knownHosts.records.size).toBe(0);
    expect(harness.savedAcl).toEqual([]);
  });

  it('reports a local denial as fixed copy', async () => {
    const harness = await makeE2eHarness();
    const invitation = await harness.mintInvitation();

    const pairing = harness.client.pair(invitation, 'iPhone Safari');
    await waitFor(() => harness.approvals.length > 0, 'the approval modal');
    harness.approvals[0]!.deny();

    expect(await pairing).toEqual({ ok: false, message: PAIRING_DENIAL_MESSAGES['user-denied'] });
    expect(harness.knownHosts.records.size).toBe(0);
  });

  /**
   * The pin is what a connection authenticates against, so a Host presenting a
   * different static is a security error rather than a fresh start — and the
   * record it disagrees with survives untouched.
   */
  it('refuses a Host whose static is not the one already pinned, keeping the old record', async () => {
    const first = await makeE2eHarness();
    await first.pairAndApprove(await first.mintInvitation());
    const pinned = first.knownHosts.records.get(first.hostId)!;

    // The same `hostId`, a different identity behind it.
    const impostor = await makeE2eHarness({
      hostId: first.hostId,
      knownHosts: first.knownHosts,
      authenticator: first.authenticator,
    });
    expect(impostor.noiseStatic.publicKey).not.toBe(first.noiseStatic.publicKey);

    await expect(impostor.pairAndApprove(await impostor.mintInvitation())).rejects.toBeInstanceOf(
      HostIdentityMismatchError,
    );
    expect(first.knownHosts.records.get(first.hostId)).toBe(pinned);
  });

  /**
   * The pin has to be an importable X25519 point. A Host announcing anything
   * else — the outcome's field is only bounded as a string on the wire — would
   * otherwise be stored, and every later `connect` would throw building a
   * handshake from it, long after the screen that could explain it is gone.
   */
  it('refuses a Host static that is not a 32-byte key, rather than pinning it', async () => {
    const harness = await makeE2eHarness({ announcedStatic: 'not-a-key' });

    const result = await harness.pairAndApprove(await harness.mintInvitation());

    expect(result).toEqual({ ok: false, message: PAIRING_DENIAL_MESSAGES['host-error'] });
    expect(harness.knownHosts.records.size).toBe(0);
  });

  /**
   * An outcome is believed only after it decrypts on this ceremony's own
   * session, so a relay that flips a byte cannot turn a pairing into anything —
   * and the failure is unavailability, never a denial.
   */
  it('believes no outcome that does not authenticate', async () => {
    const harness = await makeE2eHarness();
    const invitation = await harness.mintInvitation();

    let shown: string | null = null;
    const pairing = harness.client.pair(invitation, 'iPhone Safari', (code) => {
      shown = code;
    });
    await waitFor(() => harness.approvals.length > 0, 'the approval modal');
    harness.relay.tamperNextHostFrame();
    harness.approvals[0]!.approve(shown!);

    expect(await pairing).toEqual({ ok: false, message: HOST_UNAVAILABLE_MESSAGE });
    expect(harness.knownHosts.records.size).toBe(0);
  });

  it('queues the old delivery id when a re-pair mints a new one', async () => {
    // The Host has forgotten this Client and pairs it again, so the row the
    // previous id names is unreachable the moment the record is rewritten.
    const first = await makeE2eHarness();
    await first.pairAndApprove(await first.mintInvitation());
    const before = deliveryIdOf(first.knownHosts, first.hostId);

    await first.pairAndApprove(await first.mintInvitation());

    const after = deliveryIdOf(first.knownHosts, first.hostId);
    expect(after).not.toBe(before);
    expect([...first.pendingDeletions.records.values()].map((t) => t.deliveryId)).toContain(before);
  });

  it('reports a Host that never answers as unavailable, not as a refusal', async () => {
    const clock = expiringClock();
    const harness = await makeE2eHarness({ now: clock.now });
    const invitation = await harness.mintInvitation();
    harness.relay.stop();
    clock.expire();

    expect(await harness.client.pair(invitation, 'iPhone Safari')).toEqual({
      ok: false,
      message: HOST_UNAVAILABLE_MESSAGE,
    });
  });
});

// --- Connection -------------------------------------------------------------

describe('connecting, end to end', () => {
  it('runs IK against the pin, proves presence, and carries protocol-v1 inside', async () => {
    const harness = await makeE2eHarness();
    await harness.pairAndApprove(await harness.mintInvitation());

    const result = await harness.client.connect(harness.hostId);

    expect(result).toEqual({ ok: true, hostLabel: HOST_LABEL });
    expect(harness.client.connectedHostId).toBe(harness.hostId);
    // The same Noise session carries the terminal protocol.
    expect(await harness.client.hello()).toMatchObject({ protocolVersion: 1 });
  });

  it('needs a record: an unpinned Host is a pairing, not a connection', async () => {
    const harness = await makeE2eHarness();

    expect(await harness.client.connect(harness.hostId)).toEqual({
      ok: false,
      message: CONNECTION_DENIAL_MESSAGES['pairing-required'],
      pairingRequired: true,
    });
  });

  /**
   * The ACL is the Host's, and it can lose this Client without the pin
   * changing. The tombstone is written before the record forgets the delivery
   * id — that id is the only handle that can ever delete the Server's row.
   */
  it('drops authorization on pairing-required, tombstoning the delivery id first', async () => {
    const paired = await makeE2eHarness();
    await paired.pairAndApprove(await paired.mintInvitation());
    const deliveryId = deliveryIdOf(paired.knownHosts, paired.hostId);

    // The same Host identity, an ACL that has forgotten this Client.
    const reset = await makeE2eHarness({
      hostId: paired.hostId,
      knownHosts: paired.knownHosts,
      pendingDeletions: paired.pendingDeletions,
      authenticator: paired.authenticator,
      noiseStatic: paired.noiseStatic,
      loadAcl: () => [],
    });

    const result = await reset.client.connect(reset.hostId);

    expect(result).toEqual({
      ok: false,
      message: CONNECTION_DENIAL_MESSAGES['pairing-required'],
      pairingRequired: true,
    });
    expect(paired.knownHosts.records.get(paired.hostId)!.authorization).toEqual({
      state: 'pairing-required',
    });
    // The pin survives losing authorization — re-pairing against a changed
    // static has to stay a security error.
    expect(paired.knownHosts.records.get(paired.hostId)!.hostStaticPublicKey).toBe(
      paired.noiseStatic.publicKey,
    );
    // Deleted at the Server, so the tombstone cleared; the id was queued first.
    expect(reset.calls.some((c) => c.url.endsWith(deliveryId) && c.method === 'DELETE')).toBe(true);
    expect([...paired.pendingDeletions.records.values()]).toEqual([]);
  });

  /**
   * The outcome is authenticated, so the row has to move to *Pair again*
   * whatever the local stores do. A tombstone write that throws leaves the
   * record `paired` — the safe half, since the next Connect earns the same
   * denial and retries — but the caller must still get the ConnectResult
   * rather than a raw IndexedDB error the UI would print at the user.
   */
  it('still reports pairing-required when the tombstone cannot be written', async () => {
    const paired = await makeE2eHarness();
    await paired.pairAndApprove(await paired.mintInvitation());
    const reset = await makeE2eHarness({
      hostId: paired.hostId,
      knownHosts: paired.knownHosts,
      pendingDeletions: paired.pendingDeletions,
      authenticator: paired.authenticator,
      noiseStatic: paired.noiseStatic,
      loadAcl: () => [],
    });
    paired.pendingDeletions.put = () => Promise.reject(new Error('QuotaExceededError'));

    const result = await reset.client.connect(reset.hostId);

    expect(result).toEqual({
      ok: false,
      message: CONNECTION_DENIAL_MESSAGES['pairing-required'],
      pairingRequired: true,
    });
    // Tombstone first: a write that failed must not have let the record forget
    // the only id that can ever name that row.
    expect(paired.knownHosts.records.get(paired.hostId)!.authorization).toEqual({
      state: 'paired',
      deliveryId: expect.any(String),
      approvedAt: expect.any(Number),
    });
  });

  it('keeps the tombstone when the deletion cannot be delivered', async () => {
    const paired = await makeE2eHarness();
    await paired.pairAndApprove(await paired.mintInvitation());
    const reset = await makeE2eHarness({
      hostId: paired.hostId,
      knownHosts: paired.knownHosts,
      pendingDeletions: paired.pendingDeletions,
      authenticator: paired.authenticator,
      noiseStatic: paired.noiseStatic,
      loadAcl: () => [],
      pushDeleteFails: true,
    });

    await reset.client.connect(reset.hostId);

    // The id survives in the queue, which is the only handle that can ever
    // name that row again.
    expect([...paired.pendingDeletions.records.values()]).toHaveLength(1);
  });

  it('reports a relay that stops answering as unavailable', async () => {
    const clock = expiringClock();
    const harness = await makeE2eHarness({ now: clock.now });
    await harness.pairAndApprove(await harness.mintInvitation());
    harness.relay.stop();
    clock.expire();

    expect(await harness.client.connect(harness.hostId)).toEqual({
      ok: false,
      message: HOST_UNAVAILABLE_MESSAGE,
      pairingRequired: false,
    });
  });

  it('treats a poisoned established session as host loss', async () => {
    const harness = await makeE2eHarness();
    await harness.pairAndApprove(await harness.mintInvitation());
    await harness.client.connect(harness.hostId);
    let hostGone = 0;
    harness.client.setOnHostGone(() => hostGone++);

    // One flipped byte on the application stream. There is no
    // resynchronization point in a stream cipher, so the session is over.
    harness.relay.tamperNextHostFrame();
    await expect(harness.client.hello()).rejects.toThrow();
    await waitFor(() => hostGone === 1, 'the session to be torn down');
    expect(harness.client.connectedHostId).toBeNull();
  });

  /**
   * An `error` frame's text is the relay's — unbounded, unshaped, and not run
   * through any guard. `#rejectAll` fails in-flight protocol-v1 requests, whose
   * message the app renders in its alert row, so believing that text would let
   * a hostile relay pick the sentence the user reads. Same rule as the denial
   * tables: fixed copy, never a remote party's.
   */
  it('answers a relay error with fixed copy, never the relay’s own words', async () => {
    const harness = await makeE2eHarness();
    await harness.pairAndApprove(await harness.mintInvitation());
    await harness.client.connect(harness.hostId);

    const pending = harness.client.hello();
    harness.relay.errorClient('Your session was revoked — visit http://evil.example to restore it');

    await expect(pending).rejects.toThrow(HOST_UNAVAILABLE_MESSAGE);
    await expect(pending).rejects.not.toThrow(/evil\.example/);
  });

  it('leaves the phone connected to nothing when the Host drops', async () => {
    const harness = await makeE2eHarness();
    await harness.pairAndApprove(await harness.mintInvitation());
    await harness.client.connect(harness.hostId);
    let hostGone = 0;
    harness.client.setOnHostGone(() => hostGone++);

    harness.relay.hostGone();

    expect(hostGone).toBe(1);
    expect(harness.client.connectedHostId).toBeNull();
  });
});

// --- Keepalives -------------------------------------------------------------

/** One armed timer at a time, fired by hand — no test waits thirty seconds. */
function fakeTimers() {
  const armed: Array<{ run: () => void; delayMs: number; cancelled: boolean }> = [];
  return {
    setTimer(run: () => void, delayMs: number): () => void {
      const timer = { run, delayMs, cancelled: false };
      armed.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    get live() {
      return armed.filter((timer) => !timer.cancelled);
    },
    /** Fire the armed timer, as its delay elapsing would. */
    fire(): void {
      const timer = this.live.at(-1);
      if (!timer) throw new Error('no keepalive timer is armed');
      timer.cancelled = true;
      timer.run();
    },
  };
}

/** `document.visibilityState`, as a seam a test can flip. */
function fakeVisibility() {
  let visible = true;
  const listeners = new Set<() => void>();
  return {
    visibility: {
      isVisible: () => visible,
      subscribe(onChange: () => void) {
        listeners.add(onChange);
        return () => listeners.delete(onChange);
      },
    },
    set(next: boolean): void {
      visible = next;
      for (const listener of listeners) listener();
    },
  };
}

describe('keepalives on an established session', () => {
  /** A connected phone whose timer and visibility the test owns. */
  async function connected() {
    const timers = fakeTimers();
    const visibility = fakeVisibility();
    const harness = await makeE2eHarness({
      deps: { setTimer: timers.setTimer, visibility: visibility.visibility },
    });
    await harness.pairAndApprove(await harness.mintInvitation());
    expect(await harness.client.connect(harness.hostId)).toMatchObject({ ok: true });
    return { harness, timers, visibility };
  }

  /** Transport frames this phone put on the wire since `from`. */
  function sentSince(harness: E2eHarness, from: number): Array<Record<string, unknown>> {
    return harness.clientSocket().frames('e2e').slice(from);
  }

  it('sends one fixed-size keepalive per interval, and re-arms', async () => {
    const { harness, timers } = await connected();
    const before = harness.clientSocket().frames('e2e').length;

    timers.fire();

    const sent = sentSince(harness, before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'connection', step: 'transport' });
    // The kind byte, 32 zero bytes, and the Poly1305 tag: every keepalive is
    // this size, so the interval tells a timing observer nothing else.
    expect(fromBase64Url(sent[0]!.ct as string).length).toBe(1 + KEEPALIVE_BODY_SIZE + 16);
    expect(timers.live).toHaveLength(1);
    expect(timers.live[0]!.delayMs).toBe(E2E_KEEPALIVE_INTERVAL_MS);
  });

  it('pauses while the page is hidden and sends one the moment it returns', async () => {
    const { harness, timers, visibility } = await connected();
    const before = harness.clientSocket().frames('e2e').length;

    // Backgrounded: a phone in a pocket has its timers throttled, so it must
    // not promise a liveness it cannot keep.
    visibility.set(false);
    expect(timers.live).toHaveLength(0);
    expect(sentSince(harness, before)).toHaveLength(0);

    // Back in front of the user: one immediately, then the interval again.
    visibility.set(true);
    expect(sentSince(harness, before)).toHaveLength(1);
    expect(timers.live).toHaveLength(1);
  });

  it('stops when the session does', async () => {
    const { harness, timers } = await connected();
    harness.client.close();

    expect(timers.live).toHaveLength(0);
    const before = harness.clientSocket().frames('e2e').length;
    harness.client.sendKeepalive();
    expect(harness.clientSocket().frames('e2e').length).toBe(before);
  });
});

// --- Setup, sign-in, and the token a scan carries ---------------------------

describe('setup + signin', () => {
  it('registers with the scanned token, signs in, and sends the session as a bearer', async () => {
    const harness = makeClient({ ...AUTH_ROUTES });
    const token = secret();
    const setup = await harness.client.setup({ setupToken: token }, 'My Phone');
    expect(setup.credentialId).toBe(CREDENTIAL_ID);

    const signin = await harness.client.signin();
    expect(signin.sessionToken).toBe(SESSION_TOKEN);

    await harness.client.listHosts();
    const hostsCall = harness.calls.find((c) => c.url.endsWith('/api/hosts'))!;
    expect(hostsCall.method).toBe('GET');
    expect(hostsCall.headers.authorization).toBe(`Bearer ${SESSION_TOKEN}`);
    // The token is the only credential either setup route carries; there is no
    // password arm left to fall through to.
    for (const route of ['/api/setup/begin', '/api/setup/finish']) {
      const body = harness.calls.find((c) => c.url.endsWith(route))!.body as Record<string, unknown>;
      expect(body.setupToken).toBe(token);
      expect(body).not.toHaveProperty('password');
    }
  });

  /**
   * Its own error class, because Pocket has to react rather than report: a
   * spent code means "show a new one on the computer", where the shared
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

  /**
   * The exclusion doing its job. Named rather than generic because the app has
   * to act on it: the list came from the Server, so an authenticator refusing
   * over it is proof a sign-in from this very device succeeds.
   */
  it('names the authenticator’s refusal to duplicate a registered passkey', async () => {
    const harness = makeClient(
      { ...AUTH_ROUTES },
      {
        webauthn: {
          ...fakeWebAuthn,
          registerPasskey: () =>
            Promise.reject(new DOMException('already registered', 'InvalidStateError')),
        },
      },
    );

    await expect(harness.client.setup({ setupToken: 'live' }, 'Phone')).rejects.toBeInstanceOf(
      PasskeyAlreadyRegisteredError,
    );
    expect(harness.client.hasPriorUse()).toBe(false);
  });

  /**
   * The two halves of the cache-before-`finish` rule: a refusal is proof the
   * Server has nothing, a lost answer is not.
   */
  describe('the passkey cached between registerPasskey and finish', () => {
    it('is dropped when finish is refused, since the Server registered nothing', async () => {
      const harness = makeClient({
        ...AUTH_ROUTES,
        '/api/setup/finish': () => ({ status: 401, json: { error: SETUP_TOKEN_INVALID_ERROR } }),
      });

      await expect(harness.client.setup({ setupToken: 'spent' }, 'Phone')).rejects.toThrow(
        SetupTokenInvalidError,
      );

      expect(harness.client.hasPriorUse()).toBe(false);
    });

    it('survives a finish whose answer never arrived, since the Server may hold it', async () => {
      const harness = makeClient({
        ...AUTH_ROUTES,
        '/api/setup/finish': () => {
          throw new TypeError('Load failed');
        },
      });

      await expect(harness.client.setup({ setupToken: 'live' }, 'Phone')).rejects.toThrow(
        'Load failed',
      );

      expect(harness.client.hasPriorUse()).toBe(true);
    });
  });
});

describe('retireSetupToken', () => {
  it('spends a scanned code the phone will not register with', async () => {
    const harness = await signedIn();

    await harness.client.retireSetupToken('tok-from-the-qr');

    const call = harness.calls.find((c) => c.url.endsWith('/api/setup/retire'))!;
    expect(call.body).toEqual({ setupToken: 'tok-from-the-qr' });
    expect(call.headers.authorization).toBe(`Bearer ${SESSION_TOKEN}`);
  });

  it('names a refusal as a dead code, which is what the screen has to say', async () => {
    const harness = await signedIn({
      '/api/setup/retire': () => ({ status: 401, json: { error: SETUP_TOKEN_INVALID_ERROR } }),
    });

    await expect(harness.client.retireSetupToken('spent')).rejects.toBeInstanceOf(
      SetupTokenInvalidError,
    );
  });
});

// --- Web Push ---------------------------------------------------------------

describe('push registration by capability', () => {
  const SUBSCRIPTION = {
    endpoint: 'https://push.example/original',
    keys: { p256dh: 'p256dh', auth: 'auth' },
  };

  it('presents the record’s own delivery id, and records the address it registered', async () => {
    const harness = await signedIn({
      '/api/push/subscribe': () => ({ json: { subscribedAt: 1, hostIds: ['h1'] } }),
    });
    await seedRecord(harness.knownHosts, 'h1');
    expect(harness.client.registeredPushEndpoint()).toBeNull();

    await harness.client.subscribeToPush('h1', SUBSCRIPTION);

    const call = harness.calls.find((c) => c.url.endsWith('/api/push/subscribe'))!;
    expect(call.body).toEqual({
      hostId: 'h1',
      deliveryId: 'delivery-h1',
      subscription: SUBSCRIPTION,
    });
    // A digest, not the address itself — the endpoint is a bearer capability
    // and equality is all the rotation check needs.
    expect(harness.client.registeredPushEndpoint()).toBe(
      await pushEndpointFingerprint(SUBSCRIPTION.endpoint),
    );
    expect(harness.client.registeredPushEndpoint()).not.toContain('push.example');
  });

  it('refuses to register a Host this phone is not paired with', async () => {
    const harness = await signedIn();
    await seedRecord(harness.knownHosts, 'h1', {
      authorization: { state: 'pairing-required' },
    });

    await expect(harness.client.subscribeToPush('h1', SUBSCRIPTION)).rejects.toThrow('not paired');
  });

  /**
   * Parameterized by a capability the caller already holds, never by identity:
   * the query names this browser's own delivery ids, so it can report on no row
   * the caller could not already reach.
   */
  it('asks about its own delivery ids and answers with the Hosts that hold a row', async () => {
    const harness = await signedIn({
      '/api/push/subscriptions/query': () => ({
        json: { registered: [{ hostId: 'h1', deliveryId: 'delivery-h1' }] },
      }),
    });
    await seedRecord(harness.knownHosts, 'h1');
    await seedRecord(harness.knownHosts, 'h2');
    await seedRecord(harness.knownHosts, 'h3', { authorization: { state: 'pairing-required' } });

    expect(await harness.client.listPushSubscribedHosts()).toEqual(['h1']);

    const call = harness.calls.find((c) => c.url.endsWith('/api/push/subscriptions/query'))!;
    // Only paired records have a delivery id to present.
    expect(call.body).toEqual({ deliveryIds: ['delivery-h1', 'delivery-h2'] });
    expect(call.headers.authorization).toBe(`Bearer ${SESSION_TOKEN}`);
  });

  it('asks nothing when this phone holds no delivery id at all', async () => {
    const harness = await signedIn();

    expect(await harness.client.listPushSubscribedHosts()).toEqual([]);
    expect(harness.calls.some((c) => c.url.includes('/api/push/'))).toBe(false);
  });
});

describe('the durable deletion queue', () => {
  it('drains a tombstone and clears it only on the Server’s answer', async () => {
    let live = false;
    const harness = await signedIn({
      '/api/push/subscriptions/delivery-h1': () =>
        live ? { status: 204 } : { status: 503, json: { error: 'down' } },
    });
    await harness.pendingDeletions.put({ hostId: 'h1', deliveryId: 'delivery-h1', queuedAt: 1 });

    await harness.client.retirePendingDeletions();
    expect(harness.pendingDeletions.records.size).toBe(1);

    live = true;
    await harness.client.retirePendingDeletions();
    expect(harness.pendingDeletions.records.size).toBe(0);
  });

  it('does nothing before there is a session to delete with', async () => {
    const harness = makeClient({ ...AUTH_ROUTES });
    await harness.pendingDeletions.put({ hostId: 'h1', deliveryId: 'delivery-h1', queuedAt: 1 });

    // Called at app start, where signing in has not happened yet: it must not
    // throw, and it must not spend the tombstone.
    await harness.client.retirePendingDeletions();

    expect(harness.pendingDeletions.records.size).toBe(1);
  });

  it('forgetHost queues the deletion before the record that names it is gone', async () => {
    const deletes: string[] = [];
    const harness = await signedIn({
      '/api/push/subscriptions/delivery-h1': () => {
        deletes.push('delivery-h1');
        return { status: 204 };
      },
    });
    await seedRecord(harness.knownHosts, 'h1');

    await harness.client.forgetHost('h1');

    expect(harness.knownHosts.records.has('h1')).toBe(false);
    expect(deletes).toEqual(['delivery-h1']);
    expect(harness.pendingDeletions.records.size).toBe(0);
  });

  it('forgetHost still forgets a record whose delivery row cannot be deleted', async () => {
    const harness = await signedIn();
    await seedRecord(harness.knownHosts, 'h1');

    await harness.client.forgetHost('h1');

    expect(harness.knownHosts.records.has('h1')).toBe(false);
    // The id survives in the queue, which is the only thing that can name that
    // row again.
    expect([...harness.pendingDeletions.records.values()]).toEqual([
      { hostId: 'h1', deliveryId: 'delivery-h1', queuedAt: expect.any(Number) },
    ]);
  });
});

// --- The account plane ------------------------------------------------------

describe('session expiry', () => {
  it('discards the token and reports expiry on the session gate 401', async () => {
    let live = true;
    const harness = await signedIn({
      '/api/hosts': () =>
        live ? { json: { hosts: [] } } : { status: 401, json: { error: 'unauthorized' } },
    });
    expect(harness.client.sessionToken).toBe(SESSION_TOKEN);

    live = false;
    await expect(harness.client.listHosts()).rejects.toBeInstanceOf(SessionExpiredError);
    expect(harness.client.sessionToken).toBeNull();
  });

  // A refused setup token answers 401 too; treating that as expiry would sign
  // the user out mid-scan.
  it('leaves a 401 that is not the session gate as an ordinary failure', async () => {
    const harness = await signedIn({
      '/api/hosts': () => ({ status: 401, json: { error: SETUP_TOKEN_INVALID_ERROR } }),
    });

    await expect(harness.client.listHosts()).rejects.toThrow(SETUP_TOKEN_INVALID_ERROR);
    expect(harness.client.sessionToken).toBe(SESSION_TOKEN);
  });

  it('turns a rejected relay upgrade into expiry when the session is the reason', async () => {
    let live = true;
    const harness = await signedIn({
      '/api/hosts': () =>
        live ? { json: { hosts: [] } } : { status: 401, json: { error: 'unauthorized' } },
    });

    live = false;
    const opening = harness.client.openSocket();
    harness.socket.emitError();
    await expect(opening).rejects.toBeInstanceOf(SessionExpiredError);
    expect(harness.client.sessionToken).toBeNull();
  });

  it('keeps a socket failure a socket failure while the session is alive', async () => {
    const harness = await signedIn();

    const opening = harness.client.openSocket();
    harness.socket.emitError();
    await expect(opening).rejects.toThrow('relay socket error');
    expect(harness.client.sessionToken).toBe(SESSION_TOKEN);
  });
});

describe('the presence proof', () => {
  it('cannot be built without the asserted passkey’s public key', async () => {
    // A profile whose cached key was cleared mid-session. The proof carries the
    // key in full, so there is nothing to send and the recovery is a sign-in.
    const harness = await makeE2eHarness();
    const invitation = await harness.mintInvitation();
    const emptied = new PocketClient({
      wsBase: 'ws://test',
      fetch: harness.fetch,
      webauthn: { ...fakeWebAuthn, getAssertion: (c) => harness.authenticator.assert(c, ORIGIN) },
      createWebSocket: () => harness.relay.openClientSocket(),
      knownHosts: memoryKnownHosts(),
      pendingDeletions: memoryPendingDeletions(),
      // Signs in, so it holds a session — but the cache it would read the
      // public key back out of is emptied before the pairing.
      storage: { ...memoryStorage(), getPasskeyPublicKey: () => null },
    });
    await emptied.signin();

    await expect(emptied.pair(invitation, 'iPhone')).rejects.toThrow(PASSKEY_UNAVAILABLE_MESSAGE);
    expect(harness.approvals).toEqual([]);
  });

  it('is one authenticator prompt per ceremony, never a cached one', async () => {
    let assertions = 0;
    const authenticator = await createTestAuthenticator({ rpId: RP_ID, origin: ORIGIN });
    const counted: TestAuthenticator = {
      ...authenticator,
      assert: (challenge, origin) => {
        assertions++;
        return authenticator.assert(challenge, origin);
      },
    };
    const harness = await makeE2eHarness({ authenticator: counted });
    // One for the sign-in the harness performs.
    expect(assertions).toBe(1);

    await harness.pairAndApprove(await harness.mintInvitation());
    expect(assertions).toBe(2);

    await harness.client.connect(harness.hostId);
    expect(assertions).toBe(3);
  });
});

describe('hasPriorUse', () => {
  it('is false on a browser that has stored nothing', () => {
    const { client } = makeClient({});

    expect(client.hasPriorUse()).toBe(false);
  });

  it('is true once a credential public key is cached', async () => {
    const { client } = makeClient({ ...AUTH_ROUTES });
    await client.setup({ setupToken: 'live' }, 'My Phone');

    expect(client.hasPriorUse()).toBe(true);
  });

  /**
   * The auth screen picks its layout from this, so a storage that throws must
   * not take the screen down with it — and "first visit" is the safe reading,
   * because scanning is the half that can still get somewhere from nothing.
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
      storage.setRegisteredPushEndpoint('digest');
    }).not.toThrow();
  });

  it('answers reads from the in-session mirror when storage is blocked', () => {
    vi.stubGlobal('localStorage', blockedLocalStorage());
    const storage = localStoragePocketStorage();

    storage.setPasskeyPublicKey('cred-1', 'pk-1');
    storage.setRegisteredPushEndpoint('digest');

    expect(storage.getPasskeyPublicKey('cred-1')).toBe('pk-1');
    expect(storage.knownCredentialIds()).toEqual(['cred-1']);
    expect(storage.getRegisteredPushEndpoint()).toBe('digest');
    expect(storage.getPasskeyPublicKey('cred-other')).toBeNull();
  });

  it('still writes through to storage when it works, and unions both on read', () => {
    const { map, store } = fakeLocalStorage();
    map.set('dormouse-pocket:passkey:cred-old', 'pk-old');
    vi.stubGlobal('localStorage', store);
    const storage = localStoragePocketStorage();

    storage.setPasskeyPublicKey('cred-new', 'pk-new');

    expect(map.get('dormouse-pocket:passkey:cred-new')).toBe('pk-new');
    expect([...storage.knownCredentialIds()].sort()).toEqual(['cred-new', 'cred-old']);
  });

  /**
   * The pre-end-to-end Hosts view offered a button from these markers. The
   * `KnownHostV1` records replaced them, so one left behind is a claim about
   * authorization that nothing checks.
   */
  it('purges the legacy paired markers and touches nothing else', () => {
    const { map, store } = fakeLocalStorage();
    map.set('dormouse-pocket:paired:h1', '1');
    map.set('dormouse-pocket:paired:h2', '1');
    map.set('dormouse-pocket:passkey:cred-1', 'pk-1');
    map.set('dormouse-pocket:push-endpoint', 'digest');
    vi.stubGlobal('localStorage', store);

    purgeLegacyPairedMarkers();

    expect([...map.keys()].sort()).toEqual([
      'dormouse-pocket:passkey:cred-1',
      'dormouse-pocket:push-endpoint',
    ]);
  });

  it('purging is silent on a browser with no storage at all', () => {
    vi.stubGlobal('localStorage', blockedLocalStorage());

    expect(() => purgeLegacyPairedMarkers()).not.toThrow();
  });
});

it('directs a missing passkey cache back through sign-in', () => {
  expect(PASSKEY_UNAVAILABLE_MESSAGE).toContain('Sign in again');
});
