/**
 * The Pocket client's two end-to-end ceremonies, driven against the **real**
 * `BurrowRuntime` through an in-memory relay.
 *
 * The loop itself — client, relay, Burrow, and the account plane in front of
 * them — is `./test-e2e-harness.ts`, shared with the suite that runs the same
 * ceremonies over the native direct path. **No ceremony step is stubbed** there.
 *
 * The account-plane half (setup, sign-in, session expiry, push) drives a mocked
 * `fetch` alone; the relay is not involved in any of it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONTROL_PAYLOAD_SIZE,
  DEFAULT_PAIRING_TTL_MS,
  E2E_KEEPALIVE_INTERVAL_MS,
  ESTABLISHED_E2E_IDLE_TIMEOUT_MS,
  KEEPALIVE_BODY_SIZE,
  SELFHOST_ACCOUNT_ID,
  SETUP_TOKEN_INVALID_ERROR,
  formatPairingInvitationUrl,
  fromBase64Url,
  generateNoiseKeyPair,
  hashPasskeyPublicKey,
  parsePairingInvitationUrl,
  pushEndpointFingerprint,
  toBase64Url,
  type PasskeyAssertion,
  type TerminalDataEvent,
} from 'remote-lib-common';

import {
  CONNECTION_DENIAL_MESSAGES,
  BURROW_UNAVAILABLE_MESSAGE,
  BurrowIdentityMismatchError,
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
import type { KnownBurrowV1 } from './pocket-db';
import { FakeSocket } from '../test-fake-socket';
import { fakeTimers } from '../test-timers';
import {
  FakeDirectNetwork,
  type FakeDirectNetworkOptions,
  type FakePeer,
} from '../direct/test-fake-peer';
import type { DirectPeerLike } from '../direct/direct-peer';
import type { RemoteTimer } from '../ws';
import { createTestAuthenticator, settle, type TestAuthenticator } from '../test-e2e-client';
import { PasskeyAlreadyRegisteredError, type WebAuthnClient } from './webauthn';
import {
  AUTH_ROUTES,
  BURROW_LABEL,
  CREDENTIAL_ID,
  ORIGIN,
  PASSKEY_PUBLIC_KEY,
  RP_ID,
  SESSION_TOKEN,
  STREAMED_CHUNK,
  makeE2eHarness,
  makeFetch,
  memoryKnownBurrows,
  memoryPendingDeletions,
  memoryStorage,
  secret,
  waitFor,
  type E2eHarness,
  type FetchCall,
  type MemoryKnownBurrows,
  type MemoryPendingDeletions,
  type RouteHandler,
} from './test-e2e-harness';

// --- Fakes -----------------------------------------------------------------

/** The delivery id a paired record holds; throws if the record is not paired. */
function deliveryIdOf(store: MemoryKnownBurrows, burrowId: string): string {
  const authorization = store.records.get(burrowId)?.authorization;
  if (authorization?.state !== 'paired') throw new Error(`${burrowId} is not paired`);
  return authorization.deliveryId;
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

// --- The account-plane harness ---------------------------------------------

interface Harness {
  client: PocketClient;
  socket: FakeSocket;
  calls: FetchCall[];
  knownBurrows: MemoryKnownBurrows;
  pendingDeletions: MemoryPendingDeletions;
}

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

function makeClient(
  routes: Record<string, RouteHandler>,
  overrides: Partial<PocketClientDeps> = {},
): Harness {
  const socket = new FakeSocket();
  const { fetch, calls } = makeFetch(routes);
  const knownBurrows = memoryKnownBurrows();
  const pendingDeletions = memoryPendingDeletions();
  const client = new PocketClient({
    wsBase: 'ws://test',
    fetch,
    webauthn: fakeWebAuthn,
    createWebSocket: () => socket,
    knownBurrows,
    pendingDeletions,
    storage: memoryStorage(),
    ...overrides,
  });
  return { client, socket, calls, knownBurrows, pendingDeletions };
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

/** A `KnownBurrowV1` for the tests that need one without running a pairing. */
async function seedRecord(
  knownBurrows: MemoryKnownBurrows,
  burrowId: string,
  overrides: Partial<KnownBurrowV1> = {},
): Promise<KnownBurrowV1> {
  const clientStatic = await generateNoiseKeyPair();
  const record: KnownBurrowV1 = {
    burrowId,
    accountId: SELFHOST_ACCOUNT_ID,
    label: 'Laptop',
    burrowStaticPublicKey: toBase64Url((await generateNoiseKeyPair()).publicKey),
    clientStaticKeyPair: {
      privateKey: clientStatic.privateKey as CryptoKey,
      publicKeyRaw: toBase64Url(clientStatic.publicKey),
    },
    passkeyCredentialId: CREDENTIAL_ID,
    passkeyPublicKeyHash: 'hash',
    authorization: { state: 'paired', deliveryId: `delivery-${burrowId}`, approvedAt: 1 },
    ...overrides,
  };
  await knownBurrows.put(record);
  return record;
}

// --- Pairing ----------------------------------------------------------------

describe('pairing, end to end', () => {
  it('scans, handshakes, proves presence, and pins the Burrow the laptop approved', async () => {
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
    const record = harness.knownBurrows.records.get(harness.burrowId)!;
    expect(record.burrowStaticPublicKey).toBe(harness.noiseStatic.publicKey);
    // The Burrow's own label reached the phone inside the encrypted outcome; the
    // Relay never had it.
    expect(record.label).toBe(BURROW_LABEL);
    expect(record.passkeyCredentialId).toBe(harness.authenticator.credentialId);
    expect(record.passkeyPublicKeyHash).toBe(
      await hashPasskeyPublicKey(harness.authenticator.publicKey),
    );
    expect(record.authorization).toEqual({
      state: 'paired',
      deliveryId: harness.savedAcl[0]!.deliveryId,
      approvedAt: expect.any(Number),
    });
    // The Burrow authorized the static this handshake authenticated, not one the
    // payload claimed.
    expect(harness.savedAcl[0]!.clientStaticPublicKey).toBe(record.clientStaticKeyPair.publicKeyRaw);
  });

  it('takes the invitation straight off the URL the Burrow renders', async () => {
    // The whole path a scan travels: the Burrow composes, the parser answers, and
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
    expect(harness.knownBurrows.records.size).toBe(0);
    expect(harness.savedAcl).toEqual([]);
  });

  it('reports a local denial as fixed copy', async () => {
    const harness = await makeE2eHarness();
    const invitation = await harness.mintInvitation();

    const pairing = harness.client.pair(invitation, 'iPhone Safari');
    await waitFor(() => harness.approvals.length > 0, 'the approval modal');
    harness.approvals[0]!.deny();

    expect(await pairing).toEqual({ ok: false, message: PAIRING_DENIAL_MESSAGES['user-denied'] });
    expect(harness.knownBurrows.records.size).toBe(0);
  });

  /**
   * The pin is what a connection authenticates against, so a Burrow presenting a
   * different static is a security error rather than a fresh start — and the
   * record it disagrees with survives untouched.
   */
  it('refuses a Burrow whose static is not the one already pinned, keeping the old record', async () => {
    const first = await makeE2eHarness();
    await first.pairAndApprove(await first.mintInvitation());
    const pinned = first.knownBurrows.records.get(first.burrowId)!;

    // The same `burrowId`, a different identity behind it.
    const impostor = await makeE2eHarness({
      burrowId: first.burrowId,
      knownBurrows: first.knownBurrows,
      authenticator: first.authenticator,
    });
    expect(impostor.noiseStatic.publicKey).not.toBe(first.noiseStatic.publicKey);

    await expect(impostor.pairAndApprove(await impostor.mintInvitation())).rejects.toBeInstanceOf(
      BurrowIdentityMismatchError,
    );
    expect(first.knownBurrows.records.get(first.burrowId)).toBe(pinned);
  });

  /**
   * The pin has to be an importable X25519 point. A Burrow announcing anything
   * else — the outcome's field is only bounded as a string on the wire — would
   * otherwise be stored, and every later `connect` would throw building a
   * handshake from it, long after the screen that could explain it is gone.
   */
  it('refuses a Burrow static that is not a 32-byte key, rather than pinning it', async () => {
    const harness = await makeE2eHarness({ announcedStatic: 'not-a-key' });

    const result = await harness.pairAndApprove(await harness.mintInvitation());

    expect(result).toEqual({ ok: false, message: PAIRING_DENIAL_MESSAGES['burrow-error'] });
    expect(harness.knownBurrows.records.size).toBe(0);
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
    harness.relay.tamperNextBurrowFrame();
    harness.approvals[0]!.approve(shown!);

    expect(await pairing).toEqual({ ok: false, message: BURROW_UNAVAILABLE_MESSAGE });
    expect(harness.knownBurrows.records.size).toBe(0);
  });

  it('queues the old delivery id when a re-pair mints a new one', async () => {
    // The Burrow has forgotten this Client and pairs it again, so the row the
    // previous id names is unreachable the moment the record is rewritten.
    const first = await makeE2eHarness();
    await first.pairAndApprove(await first.mintInvitation());
    const before = deliveryIdOf(first.knownBurrows, first.burrowId);

    await first.pairAndApprove(await first.mintInvitation());

    const after = deliveryIdOf(first.knownBurrows, first.burrowId);
    expect(after).not.toBe(before);
    expect([...first.pendingDeletions.records.values()].map((t) => t.deliveryId)).toContain(before);
  });

  it('reports a Burrow that never answers as unavailable, not as a refusal', async () => {
    const clock = expiringClock();
    const harness = await makeE2eHarness({ now: clock.now });
    const invitation = await harness.mintInvitation();
    harness.relay.stop();
    clock.expire();

    expect(await harness.client.pair(invitation, 'iPhone Safari')).toEqual({
      ok: false,
      message: BURROW_UNAVAILABLE_MESSAGE,
    });
  });
});

// --- Connection -------------------------------------------------------------

describe('connecting, end to end', () => {
  it('runs IK against the pin, proves presence, and carries protocol-v1 inside', async () => {
    const harness = await makeE2eHarness();
    await harness.pairAndApprove(await harness.mintInvitation());

    const result = await harness.client.connect(harness.burrowId);

    expect(result).toEqual({ ok: true, burrowLabel: BURROW_LABEL });
    expect(harness.client.connectedBurrowId).toBe(harness.burrowId);
    // The same Noise session carries the terminal protocol.
    expect(await harness.client.hello()).toMatchObject({ protocolVersion: 1 });
  });

  it('hands an attached surface the whole terminal.data payload, both projections', async () => {
    const harness = await makeE2eHarness();
    await harness.pairAndApprove(await harness.mintInvitation());
    await harness.client.connect(harness.burrowId);

    const chunks: TerminalDataEvent[] = [];
    await harness.client.attach('surface-1', 80, 24, { onData: (event) => chunks.push(event) });

    // The pair travels whole: splitting it here is what left Pocket feeding
    // image base64 to the prompt heuristic (docs/specs/remote-api.md).
    expect(chunks).toEqual([STREAMED_CHUNK]);
  });

  it('needs a record: an unpinned Burrow is a pairing, not a connection', async () => {
    const harness = await makeE2eHarness();

    expect(await harness.client.connect(harness.burrowId)).toEqual({
      ok: false,
      message: CONNECTION_DENIAL_MESSAGES['pairing-required'],
      pairingRequired: true,
    });
  });

  /**
   * The ACL is the Burrow's, and it can lose this Client without the pin
   * changing. The tombstone is written before the record forgets the delivery
   * id — that id is the only handle that can ever delete the Relay's row.
   */
  it('drops authorization on pairing-required, tombstoning the delivery id first', async () => {
    const paired = await makeE2eHarness();
    await paired.pairAndApprove(await paired.mintInvitation());
    const deliveryId = deliveryIdOf(paired.knownBurrows, paired.burrowId);

    // The same Burrow identity, an ACL that has forgotten this Client.
    const reset = await makeE2eHarness({
      burrowId: paired.burrowId,
      knownBurrows: paired.knownBurrows,
      pendingDeletions: paired.pendingDeletions,
      authenticator: paired.authenticator,
      noiseStatic: paired.noiseStatic,
      loadAcl: () => [],
    });

    const result = await reset.client.connect(reset.burrowId);

    expect(result).toEqual({
      ok: false,
      message: CONNECTION_DENIAL_MESSAGES['pairing-required'],
      pairingRequired: true,
    });
    expect(paired.knownBurrows.records.get(paired.burrowId)!.authorization).toEqual({
      state: 'pairing-required',
    });
    // The pin survives losing authorization — re-pairing against a changed
    // static has to stay a security error.
    expect(paired.knownBurrows.records.get(paired.burrowId)!.burrowStaticPublicKey).toBe(
      paired.noiseStatic.publicKey,
    );
    // Deleted at the Relay, so the tombstone cleared; the id was queued first.
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
      burrowId: paired.burrowId,
      knownBurrows: paired.knownBurrows,
      pendingDeletions: paired.pendingDeletions,
      authenticator: paired.authenticator,
      noiseStatic: paired.noiseStatic,
      loadAcl: () => [],
    });
    paired.pendingDeletions.put = () => Promise.reject(new Error('QuotaExceededError'));

    const result = await reset.client.connect(reset.burrowId);

    expect(result).toEqual({
      ok: false,
      message: CONNECTION_DENIAL_MESSAGES['pairing-required'],
      pairingRequired: true,
    });
    // Tombstone first: a write that failed must not have let the record forget
    // the only id that can ever name that row.
    expect(paired.knownBurrows.records.get(paired.burrowId)!.authorization).toEqual({
      state: 'paired',
      deliveryId: expect.any(String),
      approvedAt: expect.any(Number),
    });
  });

  it('keeps the tombstone when the deletion cannot be delivered', async () => {
    const paired = await makeE2eHarness();
    await paired.pairAndApprove(await paired.mintInvitation());
    const reset = await makeE2eHarness({
      burrowId: paired.burrowId,
      knownBurrows: paired.knownBurrows,
      pendingDeletions: paired.pendingDeletions,
      authenticator: paired.authenticator,
      noiseStatic: paired.noiseStatic,
      loadAcl: () => [],
      pushDeleteFails: true,
    });

    await reset.client.connect(reset.burrowId);

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

    expect(await harness.client.connect(harness.burrowId)).toEqual({
      ok: false,
      message: BURROW_UNAVAILABLE_MESSAGE,
      pairingRequired: false,
    });
  });

  it('treats a poisoned established session as burrow loss', async () => {
    const harness = await makeE2eHarness();
    await harness.pairAndApprove(await harness.mintInvitation());
    await harness.client.connect(harness.burrowId);
    let burrowGone = 0;
    harness.client.setOnBurrowGone(() => burrowGone++);

    // One flipped byte on the application stream. There is no
    // resynchronization point in a stream cipher, so the session is over.
    harness.relay.tamperNextBurrowFrame();
    await expect(harness.client.hello()).rejects.toThrow();
    await waitFor(() => burrowGone === 1, 'the session to be torn down');
    expect(harness.client.connectedBurrowId).toBeNull();
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
    await harness.client.connect(harness.burrowId);

    const pending = harness.client.hello();
    harness.relay.errorClient('Your session was revoked — visit http://evil.example to restore it');

    await expect(pending).rejects.toThrow(BURROW_UNAVAILABLE_MESSAGE);
    await expect(pending).rejects.not.toThrow(/evil\.example/);
  });

  it('leaves the phone connected to nothing when the Burrow drops', async () => {
    const harness = await makeE2eHarness();
    await harness.pairAndApprove(await harness.mintInvitation());
    await harness.client.connect(harness.burrowId);
    let burrowGone = 0;
    harness.client.setOnBurrowGone(() => burrowGone++);

    harness.relay.burrowGone();

    expect(burrowGone).toBe(1);
    expect(harness.client.connectedBurrowId).toBeNull();
  });
});

// --- Keepalives -------------------------------------------------------------

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
  /** A connected phone whose timer, clock, and visibility the test owns. */
  async function connected(now?: () => number) {
    const timers = fakeTimers();
    const visibility = fakeVisibility();
    const harness = await makeE2eHarness({
      ...(now ? { now } : {}),
      deps: { setTimer: timers.setTimer, visibility: visibility.visibility },
    });
    await harness.pairAndApprove(await harness.mintInvitation());
    expect(await harness.client.connect(harness.burrowId)).toMatchObject({ ok: true });
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

  it('ends a session the Burrow has already reaped, rather than hanging on it', async () => {
    // The Burrow disposes a session it has not decrypted a Client message on for
    // `ESTABLISHED_E2E_IDLE_TIMEOUT_MS` and sends nothing when it does; the
    // relay socket is to the *Relay*, so nothing closes. Keepalives pause
    // while the page is hidden, so a phone in a pocket crosses that line on its
    // own — and without this it comes back to a wall whose every request hangs
    // forever with no error.
    let now = Date.now();
    const { harness, timers, visibility } = await connected(() => now);
    const gone = vi.fn();
    harness.client.setOnBurrowGone(gone);

    visibility.set(false);
    expect(timers.live).toHaveLength(0);
    now += ESTABLISHED_E2E_IDLE_TIMEOUT_MS;

    const before = harness.clientSocket().frames('e2e').length;
    visibility.set(true);

    // No keepalive into a session that no longer exists, and the app is told.
    expect(sentSince(harness, before)).toHaveLength(0);
    expect(gone).toHaveBeenCalledOnce();
    expect(timers.live).toHaveLength(0);

    // And a request on the dead session fails rather than hanging.
    await expect(harness.client.write('s1', 'ls')).rejects.toThrow();
  });

  it('fails a request on a reaped session instead of waiting for an answer', async () => {
    // The same deadline, reached without a visibility event: a tab a browser
    // never marked hidden, or a request the user makes before the resume
    // handler runs. `request` has no timeout of its own, so this check is the
    // only thing between the user and a terminal that is frozen forever.
    let now = Date.now();
    const { harness } = await connected(() => now);
    const gone = vi.fn();
    harness.client.setOnBurrowGone(gone);

    now += ESTABLISHED_E2E_IDLE_TIMEOUT_MS;
    await expect(harness.client.write('s1', 'ls')).rejects.toThrow(/away too long/);
    expect(gone).toHaveBeenCalledOnce();

    // One millisecond earlier it is still a live session, and still sends.
    const fresh = await connected(() => now);
    const before = fresh.harness.clientSocket().frames('e2e').length;
    now += ESTABLISHED_E2E_IDLE_TIMEOUT_MS - 1;
    fresh.harness.client.sendKeepalive();
    expect(sentSince(fresh.harness, before)).toHaveLength(1);
  });

  it('survives a socket that refuses the send, and keeps its interval', async () => {
    // A socket closing under the timer is the ordinary case on a phone. A
    // keepalive is the one thing that must not be what reports burrow loss: the
    // Client's own teardown paths own that, and a throw here would escape into
    // a bare timer callback with nobody to catch it.
    const { harness, timers } = await connected();
    const socket = harness.clientSocket();
    const send = vi.spyOn(socket, 'send').mockImplementation(() => {
      throw new Error('socket is closed');
    });

    expect(() => timers.fire()).not.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
    // And the next interval is still armed, so a socket that comes back is
    // keepalived again rather than silently reaped.
    expect(timers.live).toHaveLength(1);
    send.mockRestore();
  });
});

// --- The direct path --------------------------------------------------------

describe('the direct path, end to end', () => {
  /**
   * A connected phone and a real Burrow holding the two ends of one linked peer
   * pair, with every timer on both sides the test's own.
   *
   * Nothing about the negotiation is stubbed: the signals are real control
   * messages on the real session, and each side runs the shipped
   * `DirectPeer` — only the `RTCPeerConnection` underneath is in memory.
   */
  async function connectedDirect(
    options: {
      network?: FakeDirectNetworkOptions;
      /** Give the Client no peer factory, as a browser without WebRTC has. */
      clientHasPeer?: boolean;
      /** Give the Burrow none, as the VS Code host has. */
      burrowHasPeer?: boolean;
    } = {},
  ) {
    const network = new FakeDirectNetwork(options.network);
    const timers = fakeTimers();
    const clientPeers: FakePeer[] = [];
    const burrowPeers: FakePeer[] = [];
    const harness = await makeE2eHarness({
      deps: {
        setTimer: timers.setTimer,
        ...(options.clientHasPeer === false
          ? {}
          : {
              createDirectPeer: () => {
                const peer = network.createOfferer();
                clientPeers.push(peer);
                return peer;
              },
            }),
      },
      ...(options.burrowHasPeer === false
        ? {}
        : {
            burrowDirect: () => {
              const peer = network.createAnswerer();
              burrowPeers.push(peer);
              return peer;
            },
          }),
    });
    await harness.connectPaired();
    return {
      harness,
      network,
      timers,
      clientPeers,
      burrowPeers,
      /** This session's routing id, read off the envelope the Client addressed. */
      connectionId: harness
        .clientSocket()
        .frames('e2e')
        .find((frame) => frame.kind === 'connection')!.id as string,
      /** Client→relay transport frames on the connection, which stop at the switch. */
      clientFrames: harness.clientTransportFrames,
      /** Burrow→relay transport frames on this connection, which stop at its own switch. */
      burrowFrames: harness.burrowTransportFrames,
      /** Wait for the Burrow's second transport frame: its answer, or its decline. */
      answered: () =>
        waitFor(() => harness.burrowTransportFrames().length === 2, 'the Burrow to answer'),
      /** Wait until both directions have left the relay. */
      cutover: () =>
        waitFor(() => harness.client.transportPath === 'direct', 'the session to go direct'),
    };
  }

  it('offers after the outcome and cuts over, all as control messages on the relay', async () => {
    const run = await connectedDirect();
    await run.cutover();

    // Three Client→Burrow transport frames on this connection: the connection
    // request the ceremony ended with, the offer, and the switch. Nothing else
    // rides the relay, and the Relay never sees an SDP — only a padded
    // control body it cannot read.
    expect(run.clientFrames()).toHaveLength(3);
    for (const frame of run.clientFrames()) {
      expect(fromBase64Url(frame.ct as string).length).toBe(1 + CONTROL_PAYLOAD_SIZE + 16);
    }
    // And three the other way: the outcome, the answer, and the Burrow's switch.
    expect(run.burrowFrames()).toHaveLength(3);
    // Signaling only so far: the channel has carried nothing.
    expect(run.network.offererChannel!.sent).toEqual([]);
  });

  it('carries protocol-v1 on the channel afterwards, and nothing more on the relay', async () => {
    const run = await connectedDirect();
    await run.cutover();
    const clientBefore = run.clientFrames().length;
    const burrowBefore = run.burrowFrames().length;
    const chunks: TerminalDataEvent[] = [];

    expect(await run.harness.client.hello()).toMatchObject({ protocolVersion: 1 });
    await run.harness.client.watchDirectory(() => {});
    await run.harness.client.attach('surface-1', 80, 24, { onData: (e) => chunks.push(e) });
    await run.harness.client.write('surface-1', 'ls\n');

    // The relay carried none of it, in either direction.
    expect(run.clientFrames()).toHaveLength(clientBefore);
    expect(run.burrowFrames()).toHaveLength(burrowBefore);
    // The channel carried all of it — including the burrow→client stream.
    expect(run.network.offererChannel!.sent.length).toBe(4);
    expect(run.network.answererChannel!.sent.length).toBeGreaterThanOrEqual(5);
    expect(chunks).toEqual([STREAMED_CHUNK]);
  });

  it('keepalives ride the channel once the session has switched', async () => {
    const run = await connectedDirect();
    await run.cutover();
    const clientBefore = run.clientFrames().length;
    const sentBefore = run.network.offererChannel!.sent.length;

    run.timers.fireAt(E2E_KEEPALIVE_INTERVAL_MS);

    expect(run.clientFrames()).toHaveLength(clientBefore);
    const sent = run.network.offererChannel!.sent.slice(sentBefore);
    // The kind byte, 32 zero bytes, and the Poly1305 tag: the same fixed-size
    // keepalive the relay would have carried.
    expect(sent.map((frame) => frame.length)).toEqual([1 + KEEPALIVE_BODY_SIZE + 16]);
  });

  it('stays relayed and fully working against a Burrow that declines', async () => {
    const run = await connectedDirect({ burrowHasPeer: false });

    // The decline is the Burrow's second transport frame, after the outcome.
    await run.answered();
    await waitFor(() => run.clientPeers[0]!.closed, 'the Client to close its peer');

    expect(run.harness.client.transportPath).toBe('relay');
    const before = run.clientFrames().length;
    expect(await run.harness.client.hello()).toMatchObject({ protocolVersion: 1 });
    expect(run.clientFrames().length).toBeGreaterThan(before);
  });

  it('ends both ends when the channel dies after the switch', async () => {
    const run = await connectedDirect();
    await run.cutover();
    const gone = vi.fn();
    run.harness.client.setOnBurrowGone(gone);

    run.network.dropChannels();

    await waitFor(
      () => run.harness.burrow.establishedSessionCount === 0,
      'the Burrow to drop the session',
    );
    expect(gone).toHaveBeenCalledOnce();
    expect(run.harness.client.connectedBurrowId).toBeNull();
    expect(run.harness.client.transportPath).toBe('relay');
  });

  it('disposes the Client’s session on a relay frame that arrives after the switch', async () => {
    const run = await connectedDirect();
    await run.cutover();
    const gone = vi.fn();
    run.harness.client.setOnBurrowGone(gone);

    // Refused before any decrypt: the ciphertext is never even looked at.
    run.harness.clientSocket().receive({
      t: 'e2e',
      burrowId: run.harness.burrowId,
      kind: 'connection',
      id: run.connectionId,
      step: 'transport',
      ct: 'AAAA',
    });

    expect(gone).toHaveBeenCalledOnce();
    expect(run.harness.client.connectedBurrowId).toBeNull();
  });

  it('disposes the Burrow’s session on a relay frame that arrives after the switch', async () => {
    const run = await connectedDirect();
    await run.cutover();

    run.harness.relay.burrowSocket.receive({
      t: 'e2e',
      clientId: run.harness.relay.clientId,
      burrowId: run.harness.burrowId,
      kind: 'connection',
      id: run.connectionId,
      step: 'transport',
      ct: 'AAAA',
    });

    await waitFor(
      () => run.harness.burrow.establishedSessionCount === 0,
      'the Burrow to drop the session',
    );
  });

  /**
   * `isE2eCiphertext` bounds a `ct`'s alphabet and its length, not its padding,
   * so a relay can put a well-shaped envelope on the wire whose ciphertext will
   * not decode. Both ends must end the session on it, rather than throw out of
   * the socket handler or warn and drop it.
   */
  /**
   * A refused chunk disposes the session synchronously, from inside the loop
   * that is still chunking the message. The rest of it belongs nowhere: routing
   * it onto the relay would put post-switch ciphertext there and kill the peer
   * with a misleading reason.
   */
  it('stops a multi-chunk message when the channel refuses its first chunk', async () => {
    const run = await connectedDirect();
    await run.cutover();
    const clientBefore = run.clientFrames().length;
    const gone = vi.fn();
    run.harness.client.setOnBurrowGone(gone);
    // Closed under the session, which a radio gap does between two sends.
    run.network.offererChannel!.close();

    // Over one Noise message, so the transport chunks it into two ciphertexts.
    await expect(run.harness.client.write('surface-1', 'x'.repeat(70_000))).rejects.toThrow();

    expect(gone).toHaveBeenCalledOnce();
    expect(run.harness.client.connectedBurrowId).toBeNull();
    // Neither chunk reached the relay of a session that had just been torn down.
    expect(run.clientFrames()).toHaveLength(clientBefore);
  });

  it('disposes the Client’s session on a relay frame that will not decode', async () => {
    // Nothing switches, so the relay is still the path this frame belongs on
    // and the decode is the only thing that can refuse it.
    const run = await connectedDirect({ network: { opening: 'never' } });
    const gone = vi.fn();
    run.harness.client.setOnBurrowGone(gone);

    expect(() =>
      run.harness.clientSocket().receive({
        t: 'e2e',
        burrowId: run.harness.burrowId,
        kind: 'connection',
        id: run.connectionId,
        step: 'transport',
        // Two base64url characters: one byte, with nonzero trailing bits.
        ct: 'AB',
      }),
    ).not.toThrow();

    expect(gone).toHaveBeenCalledOnce();
    expect(run.harness.client.connectedBurrowId).toBeNull();
  });

  it('disposes the Burrow’s session on a relay frame that will not decode', async () => {
    const run = await connectedDirect({ network: { opening: 'never' } });

    run.harness.relay.burrowSocket.receive({
      t: 'e2e',
      clientId: run.harness.relay.clientId,
      burrowId: run.harness.burrowId,
      kind: 'connection',
      id: run.connectionId,
      step: 'transport',
      ct: 'AB',
    });

    await waitFor(
      () => run.harness.burrow.establishedSessionCount === 0,
      'the Burrow to drop the session',
    );
  });

  /**
   * What a failed decrypt kills is the end-to-end session; the relay socket is
   * to the *Relay*, and reconnecting is a fresh handshake over the one already
   * open. Nulling it without closing it would leave it live and unreferenced,
   * with the app's next `openSocket()` opening a second beside it.
   */
  it('keeps the relay socket open when the end-to-end session fails', async () => {
    const run = await connectedDirect({ network: { opening: 'never' } });
    const socket = run.harness.clientSocket();
    const gone = vi.fn();
    run.harness.client.setOnBurrowGone(gone);

    // Decodes, and then fails to decrypt: 18 bytes that are not this session's.
    socket.receive({
      t: 'e2e',
      burrowId: run.harness.burrowId,
      kind: 'connection',
      id: run.connectionId,
      step: 'transport',
      ct: 'A'.repeat(24),
    });

    expect(gone).toHaveBeenCalledOnce();
    expect(run.harness.client.connectedBurrowId).toBeNull();
    expect(run.harness.client.socketOpen).toBe(true);
    // The same socket, still open: `openSocket()` would reuse it.
    expect(run.harness.clientSocket()).toBe(socket);
    expect(socket.readyState).toBe(1);
  });

  /**
   * The race the holding queue exists for: the Burrow's answers overtake the
   * `direct-switch` that precedes them on the relay. The in-memory relay routes
   * synchronously, so the test holds that direction by hand.
   */
  it('holds channel frames until the peer’s switch, then drains them in order', async () => {
    const run = await connectedDirect({ network: { opening: 'manual' } });
    await run.answered();
    await settle();

    run.harness.relay.holdToClient();
    run.network.openChannels();
    // The Client has switched its own sends; the Burrow's switch is held.
    expect(run.harness.client.transportPath).toBe('relay');

    const order: string[] = [];
    const first = run.harness.client.hello().then(() => order.push('first'));
    const second = run.harness.client.write('surface-1', 'ls').then(() => order.push('second'));
    await settle();
    expect(order).toEqual([]);

    run.harness.relay.releaseToClient();

    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
    expect(run.harness.client.transportPath).toBe('direct');
  });

  /**
   * A Client that connects twice replaces its own session, and the peer and
   * channel of the one it replaced go with it: left alive, the orphan's channel
   * would still be reporting violations against the session that replaced it.
   */
  it('closes the previous session’s peer when the Client connects again', async () => {
    const run = await connectedDirect();
    await run.cutover();
    const firstPeer = run.clientPeers[0]!;
    const firstChannel = run.network.offererChannel!;

    const second = await run.harness.client.connect(run.harness.burrowId);
    const gone = vi.fn();
    run.harness.client.setOnBurrowGone(gone);

    expect(second.ok).toBe(true);
    expect(run.clientPeers).toHaveLength(2);
    expect(firstPeer.closed).toBe(true);

    // Nothing arriving on the orphan can touch the session that replaced it.
    firstChannel.receiveRaw('a text frame');

    expect(gone).not.toHaveBeenCalled();
    expect(run.harness.client.connectedBurrowId).toBe(run.harness.burrowId);
  });

  it('closes the Burrow’s peer with the client the Relay says is gone', async () => {
    const run = await connectedDirect();
    await run.cutover();

    run.harness.relay.burrowSocket.receive({
      t: 'client-gone',
      clientId: run.harness.relay.clientId,
    });

    await waitFor(() => run.burrowPeers[0]!.closed, 'the Burrow to close its peer');
    expect(run.harness.burrow.establishedSessionCount).toBe(0);
  });

  it('closes the Burrow’s peer when its own relay socket drops', async () => {
    const run = await connectedDirect();
    await run.cutover();

    run.harness.relay.burrowSocket.drop();

    await waitFor(() => run.burrowPeers[0]!.closed, 'the Burrow to close its peer');
    expect(run.harness.burrow.establishedSessionCount).toBe(0);
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

    await harness.client.listBurrows();
    const burrowsCall = harness.calls.find((c) => c.url.endsWith('/api/burrows'))!;
    expect(burrowsCall.method).toBe('GET');
    expect(burrowsCall.headers.authorization).toBe(`Bearer ${SESSION_TOKEN}`);
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
   * to act on it: the list came from the Relay, so an authenticator refusing
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
   * Relay has nothing, a lost answer is not.
   */
  describe('the passkey cached between registerPasskey and finish', () => {
    it('is dropped when finish is refused, since the Relay registered nothing', async () => {
      const harness = makeClient({
        ...AUTH_ROUTES,
        '/api/setup/finish': () => ({ status: 401, json: { error: SETUP_TOKEN_INVALID_ERROR } }),
      });

      await expect(harness.client.setup({ setupToken: 'spent' }, 'Phone')).rejects.toThrow(
        SetupTokenInvalidError,
      );

      expect(harness.client.hasPriorUse()).toBe(false);
    });

    it('survives a finish whose answer never arrived, since the Relay may hold it', async () => {
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
      '/api/push/subscribe': () => ({ json: { subscribedAt: 1, burrowIds: ['h1'] } }),
    });
    await seedRecord(harness.knownBurrows, 'h1');
    expect(harness.client.registeredPushEndpoint()).toBeNull();

    await harness.client.subscribeToPush('h1', SUBSCRIPTION);

    const call = harness.calls.find((c) => c.url.endsWith('/api/push/subscribe'))!;
    expect(call.body).toEqual({
      burrowId: 'h1',
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

  it('refuses to register a Burrow this phone is not paired with', async () => {
    const harness = await signedIn();
    await seedRecord(harness.knownBurrows, 'h1', {
      authorization: { state: 'pairing-required' },
    });

    await expect(harness.client.subscribeToPush('h1', SUBSCRIPTION)).rejects.toThrow('not paired');
  });

  /**
   * Parameterized by a capability the caller already holds, never by identity:
   * the query names this browser's own delivery ids, so it can report on no row
   * the caller could not already reach.
   */
  it('asks about its own delivery ids and answers with the Burrows that hold a row', async () => {
    const harness = await signedIn({
      '/api/push/subscriptions/query': () => ({
        json: { registered: [{ burrowId: 'h1', deliveryId: 'delivery-h1' }] },
      }),
    });
    await seedRecord(harness.knownBurrows, 'h1');
    await seedRecord(harness.knownBurrows, 'h2');
    await seedRecord(harness.knownBurrows, 'h3', { authorization: { state: 'pairing-required' } });

    expect(await harness.client.listPushSubscribedBurrows()).toEqual(['h1']);

    const call = harness.calls.find((c) => c.url.endsWith('/api/push/subscriptions/query'))!;
    // Only paired records have a delivery id to present.
    expect(call.body).toEqual({ deliveryIds: ['delivery-h1', 'delivery-h2'] });
    expect(call.headers.authorization).toBe(`Bearer ${SESSION_TOKEN}`);
  });

  it('asks nothing when this phone holds no delivery id at all', async () => {
    const harness = await signedIn();

    expect(await harness.client.listPushSubscribedBurrows()).toEqual([]);
    expect(harness.calls.some((c) => c.url.includes('/api/push/'))).toBe(false);
  });
});

describe('the durable deletion queue', () => {
  it('drains a tombstone and clears it only on the Relay’s answer', async () => {
    let live = false;
    const harness = await signedIn({
      '/api/push/subscriptions/delivery-h1': () =>
        live ? { status: 204 } : { status: 503, json: { error: 'down' } },
    });
    await harness.pendingDeletions.put({ burrowId: 'h1', deliveryId: 'delivery-h1', queuedAt: 1 });

    await harness.client.retirePendingDeletions();
    expect(harness.pendingDeletions.records.size).toBe(1);

    live = true;
    await harness.client.retirePendingDeletions();
    expect(harness.pendingDeletions.records.size).toBe(0);
  });

  it('does nothing before there is a session to delete with', async () => {
    const harness = makeClient({ ...AUTH_ROUTES });
    await harness.pendingDeletions.put({ burrowId: 'h1', deliveryId: 'delivery-h1', queuedAt: 1 });

    // Called at app start, where signing in has not happened yet: it must not
    // throw, and it must not spend the tombstone.
    await harness.client.retirePendingDeletions();

    expect(harness.pendingDeletions.records.size).toBe(1);
  });

  it('forgetBurrow queues the deletion before the record that names it is gone', async () => {
    const deletes: string[] = [];
    const harness = await signedIn({
      '/api/push/subscriptions/delivery-h1': () => {
        deletes.push('delivery-h1');
        return { status: 204 };
      },
    });
    await seedRecord(harness.knownBurrows, 'h1');

    await harness.client.forgetBurrow('h1');

    expect(harness.knownBurrows.records.has('h1')).toBe(false);
    expect(deletes).toEqual(['delivery-h1']);
    expect(harness.pendingDeletions.records.size).toBe(0);
  });

  it('forgetBurrow still forgets a record whose delivery row cannot be deleted', async () => {
    const harness = await signedIn();
    await seedRecord(harness.knownBurrows, 'h1');

    await harness.client.forgetBurrow('h1');

    expect(harness.knownBurrows.records.has('h1')).toBe(false);
    // The id survives in the queue, which is the only thing that can name that
    // row again.
    expect([...harness.pendingDeletions.records.values()]).toEqual([
      { burrowId: 'h1', deliveryId: 'delivery-h1', queuedAt: expect.any(Number) },
    ]);
  });
});

// --- The account plane ------------------------------------------------------

describe('session expiry', () => {
  it('discards the token and reports expiry on the session gate 401', async () => {
    let live = true;
    const harness = await signedIn({
      '/api/burrows': () =>
        live ? { json: { burrows: [] } } : { status: 401, json: { error: 'unauthorized' } },
    });
    expect(harness.client.sessionToken).toBe(SESSION_TOKEN);

    live = false;
    await expect(harness.client.listBurrows()).rejects.toBeInstanceOf(SessionExpiredError);
    expect(harness.client.sessionToken).toBeNull();
  });

  // A refused setup token answers 401 too; treating that as expiry would sign
  // the user out mid-scan.
  it('leaves a 401 that is not the session gate as an ordinary failure', async () => {
    const harness = await signedIn({
      '/api/burrows': () => ({ status: 401, json: { error: SETUP_TOKEN_INVALID_ERROR } }),
    });

    await expect(harness.client.listBurrows()).rejects.toThrow(SETUP_TOKEN_INVALID_ERROR);
    expect(harness.client.sessionToken).toBe(SESSION_TOKEN);
  });

  it('turns a rejected relay upgrade into expiry when the session is the reason', async () => {
    let live = true;
    const harness = await signedIn({
      '/api/burrows': () =>
        live ? { json: { burrows: [] } } : { status: 401, json: { error: 'unauthorized' } },
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
      knownBurrows: memoryKnownBurrows(),
      pendingDeletions: memoryPendingDeletions(),
      // Signs in, so it holds a session — but the cache it would read the
      // public key back out of is emptied before the pairing.
      storage: { ...memoryStorage(), getPasskeyPublicKey: () => null },
    });
    await emptied.signin();

    await expect(emptied.pair(invitation, 'iPhone')).rejects.toThrow(PASSKEY_UNAVAILABLE_MESSAGE);
    expect(emptied.sessionToken).toBeNull();
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

    await harness.client.connect(harness.burrowId);
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
   * `setup` commits the Relay's passkey *before* caching its public key, so a
   * write that throws here would strand the visit past the point of no return —
   * and every retry would mint another orphan passkey Relay-side.
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
   * The pre-end-to-end Burrows view offered a button from these markers. The
   * `KnownBurrowV1` records replaced them, so one left behind is a claim about
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
