/**
 * The whole remote loop in memory — a real `PocketClient`, a real `TestRelay`,
 * and a real `BurrowRuntime` — as a test drives it.
 *
 * Test-only, and shared for the reason `../test-relay.ts` and
 * `../test-e2e-client.ts` are: every suite that runs a phone against a Burrow
 * has to be driven against *the same* idea of what the account plane answers,
 * and two copies would be two opinions about what a signed-in Client is.
 *
 * **No ceremony step is stubbed.** The Noise handshakes are the shipped suite,
 * the presence proofs are real ES256 assertions over the shared challenge
 * builder — verified by the same `verifyPresenceProof` a Burrow runs — and the
 * outcomes are decrypted on the session that produced them. Only the browser
 * and network edges are faked: `fetch`, `WebSocket`, WebAuthn's two calls, and
 * the two IndexedDB stores. `/api/reauth/*` is faked faithfully rather than
 * simulated: `begin` derives the challenge from the presented binding with the
 * shared builder, exactly as the Relay does, so the assertion the authenticator
 * produces is one the Burrow accepts.
 */

import {
  DEFAULT_PAIRING_TTL_MS,
  REMOTE_EVENTS,
  REMOTE_METHODS,
  SELFHOST_ACCOUNT_ID,
  generateNoiseKeyPair,
  mintNoiseStaticKeyPair,
  presenceChallenge,
  randomBase64Url,
  toBase64Url,
  utf8Encode,
  type BurrowAclRecord,
  type NoiseStaticKeyMaterial,
  type PairingInvitation,
  type PresenceBinding,
  type TerminalDataEvent,
} from 'remote-lib-common';

import { PocketClient, type PocketClientDeps, type PocketStorage } from './pocket-client';
import type {
  KnownBurrowStore,
  KnownBurrowV1,
  PendingDeletionStore,
  PendingDeliveryDeletionV1,
} from './pocket-db';
import type { WebAuthnClient } from './webauthn';
import { BurrowRuntime } from '../burrow/burrow-runtime';
import type { BurrowEnrollment } from '../burrow/enrollment';
import type { PendingPairing } from '../burrow/pairing-approval';
import type { DirectPeerLike } from '../direct/direct-peer';
import { FakeSocket } from '../test-fake-socket';
import { createTestAuthenticator, pollFor, type TestAuthenticator } from '../test-e2e-client';
import { createTestRelay, type TestRelay } from '../test-relay';

// --- Fakes ------------------------------------------------------------------

export const ORIGIN = 'https://pocket.example';
export const RP_ID = 'pocket.example';
export const BURROW_LABEL = 'Ned’s laptop';
export const SESSION_TOKEN = 'tok-abc';
/** What the stub Burrow streams on attach: a chunk whose two projections differ. */
export const STREAMED_CHUNK: TerminalDataEvent = {
  bytes: toBase64Url(utf8Encode('pre\x1b]1337;File=inline=1:AAAA\x07post')),
  text: toBase64Url(utf8Encode('prepost')),
};

/** A base64url string usable where a real 32-byte secret goes. */
export function secret(): string {
  return randomBase64Url(32);
}

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type RouteHandler = (
  body: unknown,
) => { status?: number; json?: unknown } | Promise<{ status?: number; json?: unknown }>;

/** A router-style fake `fetch` that records every call. */
export function makeFetch(
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
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

export function memoryStorage(): PocketStorage {
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

export interface MemoryKnownBurrows extends KnownBurrowStore {
  readonly records: Map<string, KnownBurrowV1>;
}

export function memoryKnownBurrows(): MemoryKnownBurrows {
  const records = new Map<string, KnownBurrowV1>();
  return {
    records,
    generateKey: () => generateNoiseKeyPair(),
    get: async (burrowId) => records.get(burrowId) ?? null,
    getSummary: async (burrowId) => {
      const value = records.get(burrowId);
      if (!value) return null;
      const { clientStaticKeyPair: _key, ...summary } = value;
      return summary;
    },
    listSummaries: async () => [...records.values()].map(({ clientStaticKeyPair: _key, ...summary }) => summary),
    put: async (record) => void records.set(record.burrowId, record),
    delete: async (burrowId) => void records.delete(burrowId),
    list: async () => [...records.values()],
  };
}

export interface MemoryPendingDeletions extends PendingDeletionStore {
  readonly records: Map<string, PendingDeliveryDeletionV1>;
}

export function memoryPendingDeletions(): MemoryPendingDeletions {
  const records = new Map<string, PendingDeliveryDeletionV1>();
  return {
    records,
    put: async (record) => void records.set(`${record.burrowId}:${record.deliveryId}`, record),
    delete: async (burrowId, deliveryId) => void records.delete(`${burrowId}:${deliveryId}`),
    list: async () => [...records.values()],
  };
}

/**
 * Poll until `predicate` holds, so a Burrow awaiting WebCrypto can catch up.
 *
 * The default budget covers a ceremony step, which is a run of awaited
 * WebCrypto calls and nothing else. A caller waiting on something with a
 * network in it — a real ICE negotiation — names its own.
 */
export async function waitFor(
  predicate: () => boolean,
  what = 'a condition',
  timeoutMs = 800,
): Promise<void> {
  const held = await pollFor(() => predicate() || undefined, timeoutMs);
  if (!held) throw new Error(`timed out waiting for ${what}`);
}

/**
 * A peer factory that keeps what it builds, so a case can close or inspect the
 * far end by hand. Both ends of a session get their own array.
 */
export function collect<T>(into: T[], build: () => T): () => T {
  return () => {
    const peer = build();
    into.push(peer);
    return peer;
  };
}

export const CREDENTIAL_ID = 'cred-123';
export const PASSKEY_PUBLIC_KEY = 'pk-spki-b64u';

export const AUTH_ROUTES: Record<string, RouteHandler> = {
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
  '/api/burrows': () => ({ json: { burrows: [{ burrowId: 'h1', label: 'Laptop', online: true }] } }),
};

/** One socket's `e2e` frames on an established connection, in order. */
function transportFrames(frames: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return frames.filter((frame) => frame.kind === 'connection' && frame.step === 'transport');
}

export interface E2eHarness {
  client: PocketClient;
  burrow: BurrowRuntime;
  relay: TestRelay;
  burrowId: string;
  authenticator: TestAuthenticator;
  noiseStatic: NoiseStaticKeyMaterial;
  knownBurrows: MemoryKnownBurrows;
  pendingDeletions: MemoryPendingDeletions;
  approvals: PendingPairing[];
  savedAcl: BurrowAclRecord[];
  calls: FetchCall[];
  /** The harness's own `fetch`, for a second client on the same fake Relay. */
  fetch: typeof globalThis.fetch;
  /** The Client's relay socket, once one is open — what a keepalive lands on. */
  clientSocket(): FakeSocket;
  /**
   * Client→relay `transport` frames on the established connection, which stop
   * at this end's `direct-switch`.
   */
  clientTransportFrames(): Array<Record<string, unknown>>;
  /** The same, the other way: the Burrow's, which stop at its own switch. */
  burrowTransportFrames(): Array<Record<string, unknown>>;
  /** One live invitation, as `setupQr` would mint it. */
  mintInvitation(): Promise<PairingInvitation>;
  /** Pair, approve, and connect — the whole ceremony every session case starts with. */
  connectPaired(): Promise<void>;
  /** Run a pairing and confirm it on the Burrow with the digits the phone showed. */
  pairAndApprove(
    invitation: PairingInvitation,
    options?: { code?: (shown: string) => string },
  ): Promise<Awaited<ReturnType<PocketClient['pair']>>>;
}

/**
 * A real Burrow, a real relay, and a real client — the whole loop in memory.
 *
 * `/api/reauth/*` is faked, but faithfully: `begin` derives the challenge from
 * the presented binding with the shared builder, exactly as the Relay does, so
 * the assertion the authenticator produces is one `verifyPresenceProof`
 * accepts. Nothing else about the proof is simulated.
 */
export async function makeE2eHarness(
  options: {
    burrowId?: string;
    knownBurrows?: MemoryKnownBurrows;
    pendingDeletions?: MemoryPendingDeletions;
    authenticator?: TestAuthenticator;
    noiseStatic?: NoiseStaticKeyMaterial;
    /**
     * What the Burrow *announces* as its static, when that has to differ from the
     * key it actually handshakes with. Nothing on the Burrow validates this
     * string, so it is how a malformed pin reaches the Client at all.
     */
    announcedStatic?: string;
    loadAcl?: () => BurrowAclRecord[];
    now?: () => number;
    /** Make every delivery-row deletion fail, as an offline phone's would. */
    pushDeleteFails?: boolean;
    /** Extra `PocketClient` deps — the keepalive timer and visibility seams. */
    deps?: Partial<PocketClientDeps>;
    /** How this Burrow builds a peer for the direct path; absent, it declines. */
    burrowDirect?: () => DirectPeerLike | null;
  } = {},
): Promise<E2eHarness> {
  const burrowId = options.burrowId ?? randomBase64Url(16);
  const authenticator =
    options.authenticator ?? (await createTestAuthenticator({ rpId: RP_ID, origin: ORIGIN }));
  const noiseStatic = options.noiseStatic ?? (await mintNoiseStaticKeyPair());
  const knownBurrows = options.knownBurrows ?? memoryKnownBurrows();
  const pendingDeletions = options.pendingDeletions ?? memoryPendingDeletions();
  const approvals: PendingPairing[] = [];
  let savedAcl: BurrowAclRecord[] = [];

  const enrollment: BurrowEnrollment = {
    relayUrl: ORIGIN,
    burrowId,
    burrowToken: 'burrow-tok',
    origin: ORIGIN,
    rpId: RP_ID,
    label: BURROW_LABEL,
    noiseStaticPrivateKey: noiseStatic.privateKeyPkcs8,
    noiseStaticPublicKey: options.announcedStatic ?? noiseStatic.publicKey,
  };
  const burrowSocket = new FakeSocket();
  const burrow = new BurrowRuntime({
    enrollment,
    reconnect: false,
    createWebSocket: () => burrowSocket,
    ...(options.burrowDirect ? { createDirectPeer: options.burrowDirect } : {}),
    loadAcl: options.loadAcl ?? (() => []),
    saveAcl: (_burrowId, records) => {
      savedAcl = [...records];
    },
    requestApproval: (pending) => approvals.push(pending),
    dismissApproval: () => {},
    createSession: ({ send }) => ({
      // Enough protocol-v1 to prove the byte stream: every request is answered
      // with its own `requestId`, which is what `hello` correlates on.
      handle: (data) => {
        const request = data as { requestId?: unknown; method?: unknown };
        if (typeof request.requestId !== 'string') return;
        send({
          requestId: request.requestId,
          ok: true,
          result: { protocolVersion: 1, burrowId, grants: { input: true, layout: false } },
        });
        // An attach opens its stream under the request's own id, so one canned
        // event proves the subscription path as well as the request one.
        if (request.method === REMOTE_METHODS.surfaceAttach) {
          send({
            subId: request.requestId,
            event: REMOTE_EVENTS.terminalData,
            data: STREAMED_CHUNK,
          });
        }
      },
      dispose: () => {},
    }),
  });
  burrow.start();
  burrowSocket.open();
  const relay = createTestRelay({ burrowId, burrowSocket });

  // The presence routes, derived exactly as the Relay derives them.
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
      const relayNonce = secret();
      nonces.set(relayNonce, binding);
      return {
        json: {
          challenge: await presenceChallenge(binding, relayNonce),
          rpId: RP_ID,
          relayNonce,
          allowCredentials: [binding.passkeyCredentialId],
        },
      };
    },
    '/api/reauth/finish': (body) => {
      const { relayNonce } = body as { relayNonce: string };
      if (!nonces.delete(relayNonce)) return { status: 400, json: { error: 'unknown nonce' } };
      return { json: { verifiedAt: 1 } };
    },
  };
  // The delivery ids a Burrow mints are random, so the deletion route is matched
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
    // The real thing: a signature this Burrow's own verifier accepts.
    getAssertion: (challenge) => authenticator.assert(challenge, ORIGIN),
  };
  let clientSocket: FakeSocket | null = null;
  const requireClientSocket = (): FakeSocket => {
    if (!clientSocket) throw new Error('the Client has not opened a relay socket');
    return clientSocket;
  };
  const client = new PocketClient({
    wsBase: 'ws://test',
    fetch,
    webauthn,
    createWebSocket: () => (clientSocket = relay.openClientSocket()),
    knownBurrows,
    pendingDeletions,
    storage,
    ...(options.now ? { now: options.now } : {}),
    ...options.deps,
  });
  // Sign-in caches the asserted passkey's public key and names the credential
  // every presence proof is built from, exactly as it does in the app.
  await client.signin();

  const mintInvitation: E2eHarness['mintInvitation'] = () =>
    burrow.mintInvitation(secret(), Date.now() + DEFAULT_PAIRING_TTL_MS);
  const pairAndApprove: E2eHarness['pairAndApprove'] = async (invitation, { code } = {}) => {
    // Counted from here: a harness that pairs twice must confirm the *new*
    // request rather than re-answering the one still in the log.
    const before = approvals.length;
    let shown: string | null = null;
    const pairing = client.pair(invitation, 'iPhone Safari', (value) => {
      shown = value;
    });
    await waitFor(() => approvals.length > before, 'the Burrow to surface an approval');
    const pending = approvals[approvals.length - 1]!;
    pending.approve(code ? code(shown!) : shown!);
    return await pairing;
  };

  return {
    client,
    burrow,
    relay,
    burrowId,
    authenticator,
    noiseStatic,
    knownBurrows,
    pendingDeletions,
    approvals,
    get savedAcl() {
      return savedAcl;
    },
    calls,
    fetch,
    clientSocket: requireClientSocket,
    clientTransportFrames: () => transportFrames(requireClientSocket().frames('e2e')),
    burrowTransportFrames: () => transportFrames(relay.burrowSocket.frames('e2e')),
    mintInvitation,
    pairAndApprove,
    async connectPaired() {
      await pairAndApprove(await mintInvitation());
      const outcome = await client.connect(burrowId);
      if (!outcome.ok) throw new Error(`the connect was denied: ${outcome.message}`);
    },
  };
}
