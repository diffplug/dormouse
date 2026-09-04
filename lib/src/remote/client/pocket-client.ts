/**
 * UI-free Pocket protocol client. It speaks exactly one wire: the `e2e`
 * envelope of `docs/specs/server.md` → Relay, carrying the two end-to-end
 * ceremonies of `docs/specs/remote-security-model.md` (Pairing, Connection) and
 * — once a connection is established — protocol-v1 as application messages on
 * the same Noise session (`docs/specs/remote-api.md` owns their correlation).
 *
 * There is no plaintext path, no fallback, and no runtime selector: a Host that
 * cannot complete a ceremony is a Host this Client cannot reach.
 */

import {
  API_ROUTES,
  DEFAULT_CHALLENGE_TTL_MS,
  DEFAULT_PAIRING_TTL_MS,
  E2E_ID_BYTE_LENGTH,
  E2E_KEEPALIVE_INTERVAL_MS,
  ESTABLISHED_E2E_IDLE_TIMEOUT_MS,
  MAX_PUSH_QUERY_DELIVERY_IDS,
  NoiseTransportSession,
  REMOTE_EVENTS,
  REMOTE_METHODS,
  SELFHOST_ACCOUNT_ID,
  SETUP_TOKEN_INVALID_ERROR,
  UNAUTHORIZED_ERROR,
  WS_ROUTES,
  WS_TOKEN_PARAM,
  createNoiseInitiator,
  e2eConnectionPrologue,
  fromBase64Url,
  generateNoiseKeyPair,
  hashPasskeyPublicKey,
  isConnectionOutcomeV1,
  isE2eServerToClientFrame,
  isNoisePublicKey,
  isPairingOutcomeV1,
  pairingInvitationPrologue,
  pushEndpointFingerprint,
  pushSubscriptionDeletePath,
  randomBase64Url,
  samplePairingCode,
  toBase64Url,
  utf8Decode,
  utf8Encode,
  type ConnectionDenialCode,
  type ConnectionRequestV1,
  type DirectoryEntry,
  type DirectorySnapshot,
  type E2eClientFrame,
  type E2eClientStep,
  type E2eKind,
  type E2eServerToClientFrame,
  type HelloResult,
  type HostsResponse,
  type PairingDenialCode,
  type PairingInvitation,
  type PairingRequestV1,
  type PresenceBinding,
  type PresenceProofV1,
  type PushConfigResponse,
  type PushSubscribeResponse,
  type PushSubscriptionPayload,
  type PushSubscriptionsQueryResponse,
  type ReauthBeginResponse,
  type ReauthFinishResponse,
  type RemoteEventMsg,
  type RemoteResponse,
  type ServerToClientFrame,
  type SetupBeginResponse,
  type SetupFinishResponse,
  type SigninBeginResponse,
  type SigninFinishResponse,
  type TerminalAttachResult,
  type TerminalClosedEvent,
  type TerminalDataEvent,
} from 'remote-lib-common';
import {
  PasskeyAlreadyRegisteredError,
  isPasskeyAlreadyRegistered,
  type PasskeyRegistration,
  type WebAuthnClient,
} from './webauthn';
import {
  type KnownHostStore,
  type KnownHostV1,
  type PendingDeletionStore,
} from './pocket-db';
import { hostTimer, type RemoteTimer, type RemoteWebSocket } from '../ws';

/** The slice of a WebSocket the client uses; a browser `WebSocket` satisfies it. */
export type PocketSocket = RemoteWebSocket;

/**
 * Persistent per-device state that is *not* an end-to-end identity — those live
 * in IndexedDB ({@link KnownHostStore}). Passkey public keys are cached by
 * credential id at registration *and* at sign-in — the Server returns the
 * asserted key — so any browser profile holding a synced passkey can build a
 * presence proof, not only the one that performed the registration.
 */
export interface PocketStorage {
  getPasskeyPublicKey(credentialId: string): string | null;
  setPasskeyPublicKey(credentialId: string, publicKey: string): void;
  /**
   * Drop a cached key again. Only {@link PocketClient.setup} calls it, for a
   * credential it cached moments earlier and the Server then refused, so it
   * never has an older visit's key to lose.
   */
  forgetPasskeyPublicKey(credentialId: string): void;
  /** Credential ids this device has stored a public key for (may be empty). */
  knownCredentialIds(): string[];
  /**
   * Digest of the delivery address last registered with the Server, or null if
   * this device has never registered one. Per device, not per Host: one
   * service-worker scope holds one subscription, so if it rotates, every Host
   * row for this device is stale at once.
   */
  getRegisteredPushEndpoint(): string | null;
  setRegisteredPushEndpoint(fingerprint: string): void;
}

/**
 * Whether this page is in front of the user, and a way to be told when that
 * changes. Injectable because keepalives are the one thing Pocket does on a
 * timer, and a test must not wait thirty real seconds to see one.
 */
export interface PocketVisibility {
  isVisible(): boolean;
  /** Subscribe to visibility changes; returns an unsubscribe. */
  subscribe(onChange: () => void): () => void;
}

export interface PocketClientDeps {
  /** Prepended to API routes; `''` for same-origin (the served app). */
  readonly baseUrl?: string;
  /** Base for the `/ws/client` URL, e.g. `wss://host`; derived from origin in the app. */
  readonly wsBase: string;
  readonly fetch: typeof fetch;
  readonly webauthn: WebAuthnClient;
  readonly createWebSocket: (url: string) => PocketSocket;
  /** The pinned per-Host records: this Client's whole authorization state. */
  readonly knownHosts: KnownHostStore;
  /** Delivery ids owed a deletion; see {@link PocketClient.retirePendingDeletions}. */
  readonly pendingDeletions: PendingDeletionStore;
  readonly storage?: PocketStorage;
  readonly now?: () => number;
  /** The keepalive timer; see {@link RemoteTimer}. */
  readonly setTimer?: RemoteTimer;
  readonly visibility?: PocketVisibility;
}

/** Terminal stream callbacks for {@link PocketClient.attach}. */
export interface TerminalHandlers {
  /** One `terminal.data` payload: the renderer projection, and the text one
   *  when it differs. Passed whole rather than as bytes so the pair cannot be
   *  split here (`docs/specs/remote-api.md` → "Terminal surfaces"). */
  onData(event: TerminalDataEvent): void;
  onClosed?(exitCode?: number): void;
}

/**
 * A failure the Server *answered* with — any response it rejected — as opposed
 * to a request that never got an answer at all (DNS, TLS, the radio), which
 * leaves `fetch`'s own `TypeError` to propagate untouched. The distinction is
 * load-bearing exactly once, in {@link PocketClient.setup}: it decides whether
 * the Server can be assumed to hold nothing.
 */
export class ServerRefusalError extends Error {
  /**
   * The HTTP status behind the refusal, `0` where none was read.
   *
   * Carried because "the Server answered" and "the Server answered *this*" are
   * different facts, and a caller that acts on a refusal usually means one
   * status: a 404 is proof the Server holds nothing, while a 400, a 401, or a
   * 502 is a refusal of this attempt and proof of nothing at all.
   */
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = 'ServerRefusalError';
    this.status = status;
  }
}

/**
 * Shown when the Host reaped this session while the page was backgrounded.
 * Not a failure — the price of the Host being able to reclaim state a hostile
 * relay would otherwise never let it reclaim (`docs/specs/pocket-app.md`).
 */
export const HOST_SESSION_REAPED_MESSAGE =
  'This phone was away too long, so the computer let the session go. Connect again to resume.';

/** Shown when the Server no longer accepts our session token. */
export const SESSION_EXPIRED_MESSAGE = 'Your session expired. Sign in again to continue.';

/**
 * The Server rejected our session token, so nothing works until the user signs
 * in again. Distinct from an ordinary failure because the UI must react rather
 * than report: sessions live only in the Server's memory (docs/specs/server.md),
 * so they die on a 12h expiry *and* on every Server restart, and an installed
 * Pocket has no address bar to reload from. Left as a message, the user is
 * stuck holding a dead token with force-quitting the app as the only way out.
 *
 * {@link PocketClient} clears the token before throwing this, so recovery is
 * exactly "sign in again" with the passkey cache and the pinned Hosts intact.
 */
export class SessionExpiredError extends ServerRefusalError {
  constructor() {
    super(SESSION_EXPIRED_MESSAGE, 401);
    this.name = 'SessionExpiredError';
  }
}

/** Shown when the scanned code is expired, spent, or otherwise unknown. */
export const SETUP_CODE_DEAD_MESSAGE =
  'That setup code has expired. Show a new one on the computer and scan it again.';

/**
 * The Server refused the `setupToken` off a scanned code
 * ({@link SETUP_TOKEN_INVALID_ERROR}). Its own class for the reason
 * {@link SessionExpiredError} is: the UI must react rather than report — drop
 * the dead code and send the user back to the computer for a fresh one — and
 * the Server answers 401 for an unknown session too, so only the body
 * separates them ({@link SETUP_CODE_DEAD_MESSAGE} is what the user reads).
 */
export class SetupTokenInvalidError extends ServerRefusalError {
  constructor() {
    super(SETUP_CODE_DEAD_MESSAGE, 401);
    this.name = 'SetupTokenInvalidError';
  }
}

/** Shown when a Host presents a static this Client has already pinned differently. */
export const HOST_IDENTITY_MISMATCH_MESSAGE =
  'This computer is presenting a different identity than the one this phone paired with. ' +
  'Pairing was stopped. Remove it from this phone only if you know why it changed.';

/**
 * The Host answered a pairing with a static that is not the one already pinned
 * for that `hostId`. Terminal, and the old record is left exactly as it was:
 * the pin is what a connection authenticates against, so replacing it on the
 * word of the party that failed the compare would be the whole attack
 * (`docs/specs/remote-security-model.md` → Pairing).
 */
export class HostIdentityMismatchError extends Error {
  constructor() {
    super(HOST_IDENTITY_MISMATCH_MESSAGE);
    this.name = 'HostIdentityMismatchError';
  }
}

export const PASSKEY_UNAVAILABLE_MESSAGE =
  "This app no longer has the signed-in passkey's public key, so it cannot pair or connect. " +
  'Sign in again to restore it.';

/**
 * What the user reads for each Host-sent denial.
 *
 * **Fixed copy, never Host- or relay-supplied text.** The outcome is
 * authenticated but its contents are still a remote party's, and a denial is
 * one of a closed set — so the code selects a sentence written here rather than
 * rendering one that arrived on the wire.
 */
export const PAIRING_DENIAL_MESSAGES: Record<PairingDenialCode, string> = {
  'user-denied':
    'Pairing was cancelled on the computer. Show a new code there and scan it again to retry.',
  'confirmation-mismatch': 'The digits typed on the computer did not match. Show a new code and scan it again.',
  'presence-rejected': 'The computer could not verify your passkey. Sign in again, then scan a new code.',
  'invitation-expired': SETUP_CODE_DEAD_MESSAGE,
  superseded: 'Another pairing request replaced this one. Show a new code and scan it again.',
  'host-error': 'The computer could not finish pairing. Show a new code and scan it again.',
};

export const CONNECTION_DENIAL_MESSAGES: Record<ConnectionDenialCode, string> = {
  'pairing-required': 'This computer no longer recognizes this phone. Scan a new code to pair again.',
  'presence-rejected': 'The computer could not verify your passkey. Sign in again and try Connect.',
  'protocol-rejected': 'The computer refused this connection.',
  'host-busy': 'The computer is already handling as many phones as it can. Try again shortly.',
  'host-error': 'The computer could not finish the connection.',
};

/**
 * What a ceremony that simply never answered reports.
 *
 * **A timer expiring is unavailability, not a denial.** A Host that is asleep,
 * a relay that dropped the frame, and a person who never looked at the laptop
 * are indistinguishable from here, and calling any of them a refusal would send
 * the user to fix the wrong thing.
 */
export const HOST_UNAVAILABLE_MESSAGE =
  'The computer did not answer. Check that it is awake and connected, then try again.';

/** Where a pairing ended, as the UI reports it. */
export type PairingResult =
  | { readonly ok: true; readonly record: KnownHostV1 }
  | { readonly ok: false; readonly message: string };

/** Where a connection attempt ended, as the UI reports it. */
export type ConnectResult =
  | { readonly ok: true; readonly hostLabel: string }
  | { readonly ok: false; readonly message: string; readonly pairingRequired: boolean };

interface CiphertextWaiter {
  resolve(ct: string): void;
  reject(error: Error): void;
}

interface PendingRequest {
  resolve(result: unknown): void;
  reject(error: Error): void;
}

/** An authorized session: the connection's id and its two cipher states. */
interface EstablishedSession {
  readonly connectionId: string;
  readonly session: NoiseTransportSession;
  /**
   * When this Client last put a byte on this session — the mirror of the
   * Host's `lastClientActivityAt`, because that is the clock the Host reaps on
   * (`docs/specs/remote-security-model.md` → Host bounds).
   */
  lastSentAt: number;
}

export class PocketClient {
  readonly #baseUrl: string;
  readonly #wsBase: string;
  readonly #fetch: typeof fetch;
  readonly #webauthn: WebAuthnClient;
  readonly #createWebSocket: (url: string) => PocketSocket;
  readonly #knownHosts: KnownHostStore;
  readonly #pendingDeletions: PendingDeletionStore;
  readonly #storage: PocketStorage;
  readonly #now: () => number;
  readonly #setTimer: RemoteTimer;
  readonly #visibility: PocketVisibility;

  #ws: PocketSocket | null = null;
  #sessionToken: string | null = null;
  /** The credential id from the most recent sign-in (or registration). */
  #credentialId: string | null = null;
  #established: EstablishedSession | null = null;
  #connectedHostId: string | null = null;
  #onHostGone: (() => void) | null = null;
  /** Cancels the armed keepalive, and the visibility subscription behind it. */
  #cancelKeepalive: (() => void) | null = null;
  #cancelVisibility: (() => void) | null = null;

  /**
   * In-flight `e2e` waiters, keyed by `${kind}:${id}:${step}`.
   *
   * A ceremony awaits exactly one frame at a time and every id is fresh, so at
   * most one waiter per key is ever pending — {@link #expect} throws if a
   * second is registered rather than silently queueing it.
   */
  readonly #waiters = new Map<string, CiphertextWaiter>();
  /** In-flight remote-api requests, keyed by `requestId`. */
  readonly #pending = new Map<string, PendingRequest>();
  /** Live event subscriptions, keyed by `subId`. */
  readonly #events = new Map<string, (event: RemoteEventMsg) => void>();

  constructor(deps: PocketClientDeps) {
    this.#baseUrl = deps.baseUrl ?? '';
    this.#wsBase = deps.wsBase;
    this.#fetch = deps.fetch;
    this.#webauthn = deps.webauthn;
    this.#createWebSocket = deps.createWebSocket;
    this.#knownHosts = deps.knownHosts;
    this.#pendingDeletions = deps.pendingDeletions;
    this.#storage = deps.storage ?? localStoragePocketStorage();
    this.#now = deps.now ?? (() => Date.now());
    this.#setTimer = deps.setTimer ?? hostTimer;
    this.#visibility = deps.visibility ?? documentVisibility();
  }

  get sessionToken(): string | null {
    return this.#sessionToken;
  }

  get connectedHostId(): string | null {
    return this.#connectedHostId;
  }

  /**
   * Whether this browser has been used with Dormouse before, which decides
   * whether the auth screen offers sign-in at all
   * (docs/specs/pocket-app.md). The evidence is stored passkey material: setup
   * and sign-in both cache the asserted public key. Blocked site data does not
   * throw past {@link localStoragePocketStorage}'s mirror, so a setup completed
   * in this tab still flips the screen; a storage that throws anyway reads as a
   * first visit — the screen that can still get somewhere from nothing.
   */
  hasPriorUse(): boolean {
    try {
      return this.#storage.knownCredentialIds().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Digest of the delivery address this device last registered, for detecting
   * a push service that rotated the endpoint behind our back. Null until the
   * first successful registration — which reads as "no opinion", so a device
   * that registered before this was recorded is not made to re-register.
   */
  registeredPushEndpoint(): string | null {
    return this.#storage.getRegisteredPushEndpoint();
  }

  /**
   * Notified when the Host drops: a `host-gone` frame, a closed socket, or a
   * session the Host's idle reaper took while this page was hidden.
   */
  setOnHostGone(callback: (() => void) | null): void {
    this.#onHostGone = callback;
  }

  // --- Account: first-time setup + sign-in ---------------------------------

  /**
   * First-time setup: passkey registration gated by the single-use `setupToken`
   * off a scanned setup code. Follow with {@link signin}.
   */
  async setup({ setupToken }: { setupToken: string }, label: string): Promise<SetupFinishResponse> {
    const begin = await this.#setupApi<SetupBeginResponse>(API_ROUTES.setupBegin, { setupToken });
    // Excluded from the Server's list, not this browser's: a retry — after a
    // refusal, or on a device that stored nothing — must not silently mint a
    // duplicate of a credential the account already holds, while an orphan the
    // Server never registered is absent from it and is replaced as it should be.
    let registration: PasskeyRegistration;
    try {
      registration = await this.#webauthn.registerPasskey(
        begin.challenge,
        begin.rpId,
        begin.accountId,
        begin.existingCredentialIds,
      );
    } catch (err) {
      // Translated at this seam, not inside the browser wrapper, so every
      // `WebAuthnClient` — the real one and the fakes — reports the refusal the
      // same way. It is actionable: the list came from the Server, so the
      // credential blocking us is one that can sign in from this device.
      if (isPasskeyAlreadyRegistered(err)) throw new PasskeyAlreadyRegisteredError();
      throw err;
    }
    // Cached before `finish`, never after. Creating the authenticator credential
    // is the irreversible act and its public key is knowable the moment it
    // returns, so a `finish` whose answer is lost still leaves a browser that
    // reads as returning and can sign in, rather than one minting a second
    // passkey.
    this.#storage.setPasskeyPublicKey(registration.credentialId, registration.publicKey);
    let finish: SetupFinishResponse;
    try {
      finish = await this.#setupApi<SetupFinishResponse>(API_ROUTES.setupFinish, {
        setupToken,
        credentialId: registration.credentialId,
        publicKey: registration.publicKey,
        clientDataJSON: registration.clientDataJSON,
        label,
      });
    } catch (err) {
      // A refusal is proof the Server has nothing; a lost answer is not. So a
      // rejected `finish` (a dead `setupToken`, any answered error) takes the
      // cache back down — kept, it would make `hasPriorUse` promise a sign-in
      // that cannot succeed — while an unanswered one leaves it standing.
      if (err instanceof ServerRefusalError) {
        this.#storage.forgetPasskeyPublicKey(registration.credentialId);
      }
      throw err;
    }
    // Only once the Server has acknowledged it: this names the credential a
    // pairing's presence proof is built from. Sign-in refreshes it.
    this.#credentialId = registration.credentialId;
    return finish;
  }

  /**
   * Spend a scanned setup token without registering anything.
   *
   * A phone that is already signed in has no passkey to create, and a code left
   * redeemable is one a photograph of the laptop's screen could still register
   * with (`docs/specs/server.md` → Setup tokens).
   */
  async retireSetupToken(setupToken: string): Promise<void> {
    await this.#setupApi<unknown>(API_ROUTES.setupRetire, { setupToken }, this.#auth());
  }

  /**
   * The setup-gated routes, with the one 401 body only they can earn mapped to
   * {@link SetupTokenInvalidError}. Classified here rather than in {@link #api}
   * so no other route's 401 can be read as a dead code.
   */
  async #setupApi<T>(route: string, body: unknown, init?: RequestInit): Promise<T> {
    try {
      return await this.#api<T>(route, body, init);
    } catch (err) {
      // What `#api` throws for a non-ok response is the body's own `error`.
      if (err instanceof Error && err.message === SETUP_TOKEN_INVALID_ERROR) {
        throw new SetupTokenInvalidError();
      }
      throw err;
    }
  }

  /** Sign in with a discoverable passkey; keeps the session token in memory. */
  async signin(): Promise<SigninFinishResponse> {
    const begin = await this.#api<SigninBeginResponse>(API_ROUTES.signinBegin, {});
    const assertion = await this.#webauthn.getAssertion(begin.challenge, begin.rpId);
    const finish = await this.#api<SigninFinishResponse>(API_ROUTES.signinFinish, { assertion });
    this.#sessionToken = finish.sessionToken;
    this.#credentialId = assertion.credentialId;
    // Signing in is enough to pair from here. The Server returns the asserted
    // passkey's public key, so a browser profile that never performed the
    // registration — an iOS Home Screen install, a second browser — can still
    // build presence proofs instead of being pushed into creating a redundant
    // second passkey.
    this.#storage.setPasskeyPublicKey(assertion.credentialId, finish.passkeyPublicKey);
    return finish;
  }

  async listHosts(): Promise<HostsResponse['hosts']> {
    const response = await this.#api<HostsResponse>(API_ROUTES.hosts, undefined, {
      method: 'GET',
      ...this.#auth(),
    });
    return response.hosts;
  }

  // --- The pinned Hosts ----------------------------------------------------

  /** Every Host this browser holds a record for, paired or not. */
  listKnownHosts(): Promise<KnownHostV1[]> {
    return this.#knownHosts.list();
  }

  /**
   * Forget one Host locally: the tombstone is written *before* the record that
   * holds the delivery id is deleted, so an unreachable Server cannot strand a
   * push row nothing can name again.
   */
  async forgetHost(hostId: string): Promise<void> {
    const record = await this.#knownHosts.get(hostId);
    if (record?.authorization.state === 'paired') {
      await this.#tombstone(hostId, record.authorization.deliveryId);
    }
    await this.#knownHosts.delete(hostId);
    await this.retirePendingDeletions();
  }

  // --- Web Push ------------------------------------------------------------

  /**
   * The VAPID public key a browser needs before it can subscribe, or `null`
   * when the server has push disabled. Unauthenticated — the key is public by
   * construction.
   */
  async getPushConfig(): Promise<string | null> {
    const response = await this.#api<PushConfigResponse>(API_ROUTES.pushConfig, undefined, {
      method: 'GET',
    });
    return response.applicationServerKey;
  }

  /**
   * The Hosts **this device** is already registered to receive push from.
   *
   * Asked by capability rather than by identity: the query names this browser's
   * own delivery ids and the Server reports only on those, so there is no
   * endpoint that reports on a row the caller does not already hold the
   * capability for (`docs/specs/server.md` → Web Push).
   */
  async listPushSubscribedHosts(): Promise<string[]> {
    const deliveryIds = (await this.#knownHosts.list())
      .flatMap((record) =>
        record.authorization.state === 'paired' ? [record.authorization.deliveryId] : [],
      )
      // The route refuses more than this, and a browser holding that many
      // paired Hosts has bigger problems than a truncated readback.
      .slice(0, MAX_PUSH_QUERY_DELIVERY_IDS);
    if (deliveryIds.length === 0) return [];
    const response = await this.#api<PushSubscriptionsQueryResponse>(
      API_ROUTES.pushSubscriptionsQuery,
      { deliveryIds },
      this.#auth(),
    );
    return response.registered.map((row) => row.hostId);
  }

  /**
   * Register a browser push subscription against `hostId`, presenting the
   * delivery id that Host minted for this Client at pairing. Possession of the
   * id is the whole authorization — there is no challenge and no signature.
   */
  async subscribeToPush(
    hostId: string,
    subscription: PushSubscriptionPayload,
  ): Promise<PushSubscribeResponse> {
    const record = await this.#knownHosts.get(hostId);
    if (record?.authorization.state !== 'paired') {
      throw new Error('this phone is not paired with that computer');
    }
    const result = await this.#api<PushSubscribeResponse>(
      API_ROUTES.pushSubscribe,
      { hostId, deliveryId: record.authorization.deliveryId, subscription },
      this.#auth(),
    );
    // Recorded only once the Server has the row: this is a note about what the
    // Server holds, not about what the browser minted.
    this.#storage.setRegisteredPushEndpoint(await pushEndpointFingerprint(subscription.endpoint));
    return result;
  }

  /** Idempotent, and the Server always answers 204. */
  async deletePushSubscription(deliveryId: string): Promise<void> {
    await this.#api<unknown>(pushSubscriptionDeletePath(deliveryId), undefined, {
      method: 'DELETE',
      ...this.#auth(),
    });
  }

  /**
   * Drain the tombstone queue, clearing each entry only on a Server answer.
   *
   * Best-effort and never throws: its callers are boot, sign-in, and the step
   * before registering a replacement, none of which may fail over a deletion
   * that can simply be retried on the next one.
   */
  async retirePendingDeletions(): Promise<void> {
    if (this.#sessionToken === null) return;
    let queued;
    try {
      queued = await this.#pendingDeletions.list();
    } catch {
      return;
    }
    for (const tombstone of queued) {
      try {
        await this.deletePushSubscription(tombstone.deliveryId);
        await this.#pendingDeletions.delete(tombstone.hostId, tombstone.deliveryId);
      } catch {
        // Kept for the next drain: the id in the tombstone is the only handle
        // that can ever delete this row.
      }
    }
  }

  // --- Relay socket --------------------------------------------------------

  /** True while a live relay socket exists; false after any close. */
  get socketOpen(): boolean {
    return this.#ws !== null;
  }

  /** Open the `/ws/client` relay socket; resolves once it is open. */
  async openSocket(): Promise<void> {
    try {
      await this.#openSocket();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (error instanceof SessionExpiredError) throw error;
      await this.#diagnoseSocketFailure(error);
    }
  }

  #openSocket(): Promise<void> {
    const token = this.#requireToken();
    const url = `${this.#wsBase}${WS_ROUTES.client}?${WS_TOKEN_PARAM}=${encodeURIComponent(token)}`;
    const ws = this.#createWebSocket(url);
    this.#ws = ws;
    const isCurrent = () => this.#ws === ws;
    ws.addEventListener('message', (ev) => {
      if (!isCurrent()) return;
      this.#onFrame((ev as { data?: unknown }).data);
    });
    ws.addEventListener('close', () => this.#onClose(ws));
    return new Promise((resolve, reject) => {
      ws.addEventListener('open', () => {
        if (!isCurrent()) {
          reject(new Error('relay socket superseded'));
          return;
        }
        resolve();
      });
      ws.addEventListener('error', () => reject(new Error('relay socket error')));
      ws.addEventListener('close', () => reject(new Error('relay socket closed before open')));
    });
  }

  // --- Pairing -------------------------------------------------------------

  /**
   * The whole pairing ceremony against one scanned invitation
   * (`docs/specs/remote-security-model.md` → Pairing).
   *
   * The per-Host static is minted here and held only in memory until the Host
   * approves: a key persisted for a pairing that was denied would be a Client
   * identity nothing authorized. `onCode` fires the moment the two digits
   * exist, because the screen has to show them while the outcome is pending.
   */
  async pair(
    invitation: PairingInvitation,
    label: string,
    onCode?: (code: string) => void,
  ): Promise<PairingResult> {
    await this.#ensureSocket();
    const deadline = this.#now() + DEFAULT_PAIRING_TTL_MS;
    const { hostId, inviteId } = invitation;
    const route = { kind: 'pairing', id: inviteId, hostId } as const;
    const clientStatic = await generateNoiseKeyPair();
    const handshake = await createNoiseInitiator({
      prologue: pairingInvitationPrologue(invitation),
      staticKeyPair: clientStatic,
      remoteStaticPublicKey: invitation.ephPub,
    });
    const message1 = await handshake.writeMessage();
    let session: NoiseTransportSession;
    try {
      const response = await this.#exchange(route, message1, deadline);
      // Both handshake payloads are empty; anything else is a peer this Client
      // does not speak the same protocol as.
      const payload = await handshake.readMessage(fromBase64Url(response));
      if (payload.length !== 0) throw new Error('pairing message 2 carries a payload');
      session = new NoiseTransportSession(handshake.session);
    } catch (err) {
      return this.#unavailable(err);
    }
    const handshakeHash = toBase64Url(session.handshakeHash);
    const code = samplePairingCode();
    // Before the WebAuthn prompt: the person is about to be asked for a
    // biometric *and* to read two digits off this screen, and the digits have
    // to already be there when they look.
    onCode?.(code);

    const passkeyCredentialId = this.#requireCredentialId();
    const presence = await this.#provePresence({
      kind: 'pairing',
      hostId,
      handshakeHash,
      passkeyCredentialId,
    });
    const request: PairingRequestV1 = { code, label, presence };
    let outcome: unknown;
    try {
      outcome = await this.#exchangeControl(route, session, { ...request }, deadline);
    } catch (err) {
      return this.#unavailable(err);
    }
    if (!isPairingOutcomeV1(outcome)) {
      return { ok: false, message: PAIRING_DENIAL_MESSAGES['host-error'] };
    }
    if (!outcome.ok) return { ok: false, message: PAIRING_DENIAL_MESSAGES[outcome.code] };

    // The outcome is authenticated, which proves who sent it and nothing about
    // what it says: an approval naming another account, credential, or key is
    // not this ceremony's, and storing it would pin an authorization this phone
    // never asked for.
    const passkeyPublicKeyHash = await hashPasskeyPublicKey(
      this.#requirePasskeyPublicKey(passkeyCredentialId),
    );
    // The static's shape is checked here rather than trusted: the wire guard
    // bounds it as a string, and a pin that is not an importable X25519 point
    // is one no later connection can build a handshake from — a record that
    // fails at the *next* attempt, with nothing left on screen to explain it.
    if (
      outcome.accountId !== SELFHOST_ACCOUNT_ID ||
      outcome.passkeyCredentialId !== passkeyCredentialId ||
      outcome.passkeyPublicKeyHash !== passkeyPublicKeyHash ||
      !isNoisePublicKey(outcome.hostStaticPublicKey)
    ) {
      return { ok: false, message: PAIRING_DENIAL_MESSAGES['host-error'] };
    }
    const existing = await this.#knownHosts.get(hostId);
    if (existing && existing.hostStaticPublicKey !== outcome.hostStaticPublicKey) {
      // Terminal, and the old record is untouched — see HostIdentityMismatchError.
      throw new HostIdentityMismatchError();
    }
    // A re-pair mints a fresh delivery id, so the one this record is about to
    // forget has to be queued before the write that forgets it.
    if (
      existing?.authorization.state === 'paired' &&
      existing.authorization.deliveryId !== outcome.deliveryId
    ) {
      await this.#tombstone(hostId, existing.authorization.deliveryId);
    }
    const record: KnownHostV1 = {
      hostId,
      accountId: outcome.accountId,
      label: outcome.hostLabel,
      hostStaticPublicKey: outcome.hostStaticPublicKey,
      clientStaticKeyPair: {
        privateKey: clientStatic.privateKey as CryptoKey,
        publicKeyRaw: toBase64Url(clientStatic.publicKey),
      },
      passkeyCredentialId: outcome.passkeyCredentialId,
      passkeyPublicKeyHash: outcome.passkeyPublicKeyHash,
      authorization: {
        state: 'paired',
        deliveryId: outcome.deliveryId,
        approvedAt: this.#now(),
      },
    };
    await this.#knownHosts.put(record);
    return { ok: true, record };
  }

  // --- Connection ----------------------------------------------------------

  /**
   * Connect to a paired Host: IK against the pinned static, one presence proof
   * over this handshake's own transcript, and the Host's single outcome
   * (`docs/specs/remote-security-model.md` → Connection).
   */
  async connect(hostId: string): Promise<ConnectResult> {
    await this.#ensureSocket();
    const record = await this.#knownHosts.get(hostId);
    if (!record) {
      return { ok: false, message: CONNECTION_DENIAL_MESSAGES['pairing-required'], pairingRequired: true };
    }
    if (record.authorization.state !== 'paired') {
      return { ok: false, message: CONNECTION_DENIAL_MESSAGES['pairing-required'], pairingRequired: true };
    }
    const deadline = this.#now() + DEFAULT_CHALLENGE_TTL_MS;
    const connectionId = randomBase64Url(E2E_ID_BYTE_LENGTH);
    const route = { kind: 'connection', id: connectionId, hostId } as const;
    const handshake = await createNoiseInitiator({
      prologue: e2eConnectionPrologue(hostId, connectionId),
      staticKeyPair: {
        privateKey: record.clientStaticKeyPair.privateKey,
        publicKey: fromBase64Url(record.clientStaticKeyPair.publicKeyRaw),
      },
      remoteStaticPublicKey: fromBase64Url(record.hostStaticPublicKey),
    });
    let session: NoiseTransportSession;
    let hostChallenge: string;
    try {
      const response = await this.#exchange(route, await handshake.writeMessage(), deadline);
      // Message 2's payload is the Host's fresh single-use challenge, which the
      // presence binding must name.
      hostChallenge = toBase64Url(await handshake.readMessage(fromBase64Url(response)));
      session = new NoiseTransportSession(handshake.session);
    } catch (err) {
      return this.#connectionUnavailable(err);
    }
    const presence = await this.#provePresence({
      kind: 'connection',
      hostId,
      connectionId,
      hostChallenge,
      handshakeHash: toBase64Url(session.handshakeHash),
      passkeyCredentialId: record.passkeyCredentialId,
    });
    let outcome: unknown;
    try {
      const request: ConnectionRequestV1 = { presence };
      outcome = await this.#exchangeControl(route, session, { ...request }, deadline);
    } catch (err) {
      return this.#connectionUnavailable(err);
    }
    if (!isConnectionOutcomeV1(outcome)) {
      return { ok: false, message: CONNECTION_DENIAL_MESSAGES['host-error'], pairingRequired: false };
    }
    if (outcome.ok) {
      this.#established = { connectionId, session, lastSentAt: this.#now() };
      this.#connectedHostId = hostId;
      this.#startKeepalives();
      return { ok: true, hostLabel: outcome.hostLabel };
    }
    if (outcome.code === 'pairing-required') {
      // Best-effort: the outcome is authenticated and the row has to move to
      // *Pair again* whatever the local stores do. A tombstone write that
      // throws leaves the record `paired`, which is the safe half — the next
      // Connect earns the same authenticated denial and retries this.
      try {
        await this.#dropAuthorization(record);
      } catch {
        this.#disposeCeremony();
      }
    }
    return {
      ok: false,
      message: CONNECTION_DENIAL_MESSAGES[outcome.code],
      pairingRequired: outcome.code === 'pairing-required',
    };
  }

  /**
   * An authenticated `pairing-required` removes local authorization without
   * discarding the pin, and the delivery row goes with it — tombstone first,
   * because the record about to be rewritten holds the only id that can name
   * that row again.
   */
  async #dropAuthorization(record: KnownHostV1): Promise<void> {
    if (record.authorization.state !== 'paired') return;
    const { deliveryId } = record.authorization;
    await this.#tombstone(record.hostId, deliveryId);
    await this.#knownHosts.put({ ...record, authorization: { state: 'pairing-required' } });
    // Best-effort: the tombstone is what makes this retryable, so a failure
    // here costs a later drain rather than the row.
    try {
      await this.deletePushSubscription(deliveryId);
      await this.#pendingDeletions.delete(record.hostId, deliveryId);
    } catch {
      // Left queued.
    }
    this.#disposeCeremony();
  }

  async #tombstone(hostId: string, deliveryId: string): Promise<void> {
    await this.#pendingDeletions.put({ hostId, deliveryId, queuedAt: this.#now() });
  }

  // --- Remote-api v1 -------------------------------------------------------

  hello(): Promise<HelloResult> {
    return this.request<HelloResult>(REMOTE_METHODS.hello, { protocolVersion: 1, viewer: 'phone' });
  }

  /** Subscribe to the directory; returns the `subId` (call {@link unsubscribe} to stop). */
  async watchDirectory(onSnapshot: (entries: DirectoryEntry[]) => void): Promise<string> {
    const { subId } = await this.subscribe(REMOTE_METHODS.directoryWatch, {}, (event) => {
      if (event.event === REMOTE_EVENTS.directorySnapshot) {
        onSnapshot((event.data as DirectorySnapshot).entries);
      }
    });
    return subId;
  }

  /** Attach to a terminal surface with the client's size; streams via {@link TerminalHandlers}. */
  attach(
    surfaceId: string,
    cols: number,
    rows: number,
    handlers: TerminalHandlers,
  ): Promise<{ subId: string; result: TerminalAttachResult }> {
    return this.subscribe<TerminalAttachResult>(
      REMOTE_METHODS.surfaceAttach,
      { surfaceId, cols, rows },
      (event) => {
        switch (event.event) {
          case REMOTE_EVENTS.terminalData:
            handlers.onData(event.data as TerminalDataEvent);
            return;
          case REMOTE_EVENTS.terminalClosed:
            handlers.onClosed?.((event.data as TerminalClosedEvent).exitCode);
            return;
          default:
            return;
        }
      },
    );
  }

  write(surfaceId: string, bytes: string): Promise<unknown> {
    return this.request(REMOTE_METHODS.terminalWrite, { surfaceId, bytes });
  }

  resize(surfaceId: string, cols: number, rows: number): Promise<unknown> {
    return this.request(REMOTE_METHODS.terminalResize, { surfaceId, cols, rows });
  }

  detach(surfaceId: string, subId?: string): Promise<unknown> {
    if (subId) this.unsubscribe(subId);
    return this.request(REMOTE_METHODS.surfaceDetach, { surfaceId });
  }

  /** Correlated request on the established session; resolves with `result`. */
  request<T = unknown>(method: string, params?: unknown, requestId: string = uuid()): Promise<T> {
    const promise = new Promise<T>((resolve, reject) => {
      this.#pending.set(requestId, { resolve: resolve as (r: unknown) => void, reject });
    });
    try {
      this.#sendApp({ requestId, method, params });
    } catch (error) {
      this.#pending.get(requestId)?.reject(error instanceof Error ? error : new Error(String(error)));
      this.#pending.delete(requestId);
    }
    return promise;
  }

  /** Request that also opens an event subscription (Host reuses `requestId` as `subId`). */
  async subscribe<T = unknown>(
    method: string,
    params: unknown,
    onEvent: (event: RemoteEventMsg) => void,
  ): Promise<{ subId: string; result: T }> {
    const subId = uuid();
    this.#events.set(subId, onEvent);
    try {
      const result = await this.request<T>(method, params, subId);
      return { subId, result };
    } catch (error) {
      this.#events.delete(subId);
      throw error;
    }
  }

  unsubscribe(subId: string): void {
    this.#events.delete(subId);
  }

  close(): void {
    const ws = this.#ws;
    // Tear down BEFORE closing the socket: nulling #ws is what makes #onClose's
    // generation guard reject the close that follows, which is the only thing
    // keeping an intentional close from firing `host-gone`. Real sockets emit
    // that event asynchronously, but test fakes may emit it synchronously from
    // close(), so the ordering has to hold rather than merely usually hold.
    this.#teardown('relay socket closed', { notifyGone: false });
    try {
      ws?.close();
    } catch {
      // already closing
    }
  }

  // --- Internals -----------------------------------------------------------

  async #ensureSocket(): Promise<void> {
    if (!this.socketOpen) await this.openSocket();
  }

  #auth(): { headers: Record<string, string> } {
    return { headers: { authorization: `Bearer ${this.#requireToken()}` } };
  }

  /**
   * One WebAuthn assertion, bound to this ceremony and to nothing else
   * (`docs/specs/remote-security-model.md` → Presence proofs).
   *
   * **One authenticator prompt per proof, never cached and never reused.** The
   * challenge is derived from the binding, so an assertion produced here
   * authenticates no other pairing or connection; the Server's `finish` proves
   * nothing to the Host, which recomputes the challenge and verifies the same
   * assertion itself.
   */
  async #provePresence(binding: PresenceBinding): Promise<PresenceProofV1> {
    const auth = this.#auth();
    const begin = await this.#api<ReauthBeginResponse>(
      API_ROUTES.reauthBegin,
      { binding },
      auth,
    );
    const assertion = await this.#webauthn.getAssertion(
      begin.challenge,
      begin.rpId,
      begin.allowCredentials,
    );
    await this.#api<ReauthFinishResponse>(
      API_ROUTES.reauthFinish,
      { serverNonce: begin.serverNonce, assertion },
      auth,
    );
    return {
      binding,
      serverNonce: begin.serverNonce,
      accountId: SELFHOST_ACCOUNT_ID,
      passkeyCredentialId: binding.passkeyCredentialId,
      passkeyPublicKey: this.#requirePasskeyPublicKey(binding.passkeyCredentialId),
      assertion,
    };
  }

  /** Send message 1 and await the Host's message 2 for the same ceremony. */
  async #exchange(route: E2eRoute, message1: Uint8Array, deadline: number): Promise<string> {
    const key = waiterKey(route.kind, route.id, 'response');
    const awaited = this.#expect(key, deadline);
    try {
      this.#sendE2e(route, 'init', message1);
    } catch (error) {
      this.#reclaim(key, awaited, error);
      throw error;
    }
    return await awaited;
  }

  /**
   * A ceremony's one control message, and the Host's single answer to it. Both
   * ceremonies are this shape, so the send and the await share a `try`.
   *
   * **The waiter is registered before the send**, as {@link #exchange} does it:
   * an answer that arrives with no await in between — a relay that delivers
   * synchronously — would otherwise reach {@link #onE2e} with nobody waiting,
   * be dropped as an answer nobody asked for, and hang the ceremony to its
   * deadline. Keepalives are accepted and skipped; the first control message is
   * the outcome, whatever it says, and anything else is a peer this Client does
   * not speak the same protocol as.
   */
  async #exchangeControl(
    route: E2eRoute,
    session: NoiseTransportSession,
    request: Record<string, unknown>,
    deadline: number,
  ): Promise<unknown> {
    const key = waiterKey(route.kind, route.id, 'transport');
    let awaited = this.#expect(key, deadline);
    try {
      this.#sendE2e(route, 'transport', session.sendControl(request));
    } catch (error) {
      this.#reclaim(key, awaited, error);
      throw error;
    }
    for (;;) {
      const receipt = session.receive(fromBase64Url(await awaited));
      if (receipt.kind === 'control') return receipt.value;
      if (receipt.kind !== 'keepalive') throw new Error('expected a control message');
      awaited = this.#expect(key, deadline);
    }
  }

  // --- Keepalives ----------------------------------------------------------

  /**
   * One fixed-size keepalive on the established session, or nothing if there
   * is none. **The only thing that refreshes the Host's idle deadline** other
   * than real traffic (`docs/specs/remote-security-model.md` → Host bounds).
   */
  sendKeepalive(): void {
    const established = this.#established;
    const hostId = this.#connectedHostId;
    if (!established || hostId === null) return;
    if (this.#reapedByHost(established)) return;
    try {
      this.#sendE2e(
        { kind: 'connection', id: established.connectionId, hostId },
        'transport',
        established.session.sendKeepalive(),
      );
      established.lastSentAt = this.#now();
    } catch {
      // A closed socket or a poisoned session; both have their own teardown,
      // and a keepalive must not be what reports host loss.
    }
  }

  /**
   * **A session the Host has already reaped, ended here too.**
   *
   * The Host disposes an established session it has not decrypted a Client
   * message on for `ESTABLISHED_E2E_IDLE_TIMEOUT_MS` and sends nothing when it
   * does — there is no frame to send, and the relay socket this Client holds is
   * to the *Server*, so nothing closes. Keepalives pause while the page is
   * hidden, so a phone in a pocket crosses that line on its own, and without
   * this check it comes back to a wall whose every request hangs forever with
   * no error and no way out but a reload
   * ([pocket-app.md](../../../docs/specs/pocket-app.md)).
   *
   * The Host's deadline runs from the message it last decrypted, which is the
   * one this Client last sent, so the same constant answers the question on
   * both sides. Reports host loss and leaves the relay socket alone: what died
   * is the end-to-end session, and reconnecting is a fresh handshake over the
   * socket already open.
   */
  #reapedByHost(established: EstablishedSession): boolean {
    if (this.#now() - established.lastSentAt < ESTABLISHED_E2E_IDLE_TIMEOUT_MS) return false;
    this.#disposeCeremony();
    this.#rejectAll(new Error(HOST_SESSION_REAPED_MESSAGE));
    this.#onHostGone?.();
    return true;
  }

  /**
   * Keepalives run **only while the page is visible**, and returning to the
   * foreground sends one immediately — a tab hidden for less than the idle
   * timeout still has a session worth keeping
   * ([pocket-app.md](../../../docs/specs/pocket-app.md)).
   */
  #startKeepalives(): void {
    this.#stopKeepalives();
    this.#cancelVisibility = this.#visibility.subscribe(() => {
      if (this.#established && this.#visibility.isVisible()) this.sendKeepalive();
      // Re-arms while visible and cancels while hidden; one place decides.
      this.#armKeepalive();
    });
    this.#armKeepalive();
  }

  #armKeepalive(): void {
    this.#cancelKeepaliveTimer();
    if (!this.#established || !this.#visibility.isVisible()) return;
    this.#cancelKeepalive = this.#setTimer(() => {
      this.#cancelKeepalive = null;
      this.sendKeepalive();
      this.#armKeepalive();
    }, E2E_KEEPALIVE_INTERVAL_MS);
  }

  #cancelKeepaliveTimer(): void {
    this.#cancelKeepalive?.();
    this.#cancelKeepalive = null;
  }

  #stopKeepalives(): void {
    this.#cancelKeepaliveTimer();
    this.#cancelVisibility?.();
    this.#cancelVisibility = null;
  }

  /** One `e2e` envelope. Every Client→Host byte in this file goes through here. */
  #sendE2e(route: E2eRoute, step: E2eClientStep, ciphertext: Uint8Array): void {
    this.#send({
      t: 'e2e',
      hostId: route.hostId,
      kind: route.kind,
      id: route.id,
      step,
      ct: toBase64Url(ciphertext),
    });
  }

  /** One protocol-v1 message on the established session, chunked as it needs. */
  #sendApp(payload: unknown): void {
    const established = this.#established;
    if (!established) throw new Error('not connected to a host');
    const hostId = this.#connectedHostId;
    if (hostId === null) throw new Error('not connected to a host');
    if (this.#reapedByHost(established)) throw new Error(HOST_SESSION_REAPED_MESSAGE);
    const route = { kind: 'connection', id: established.connectionId, hostId } as const;
    for (const ciphertext of established.session.sendApp(utf8Encode(JSON.stringify(payload)))) {
      this.#sendE2e(route, 'transport', ciphertext);
    }
    established.lastSentAt = this.#now();
  }

  #send(frame: E2eClientFrame): void {
    if (!this.#ws) throw new Error('relay socket is not open');
    this.#ws.send(JSON.stringify(frame));
  }

  /**
   * Await one ciphertext for `key`, bounded by the ceremony's own deadline.
   *
   * A Host that never answers must not strand the key — and throw on the next
   * ask — until the socket dies. The expiry reports
   * {@link HOST_UNAVAILABLE_MESSAGE}, never a denial.
   */
  #expect(key: string, deadline: number): Promise<string> {
    if (this.#waiters.has(key)) throw new Error(`already awaiting '${key}'`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.#waiters.delete(key);
          reject(new HostUnavailableError());
        },
        Math.max(0, deadline - this.#now()),
      );
      this.#waiters.set(key, {
        resolve: (ct) => {
          clearTimeout(timer);
          resolve(ct);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  /** Reclaim a waiter whose frame never left, so its deadline cannot fire unheard. */
  #reclaim(key: string, awaited: Promise<string>, error: unknown): void {
    this.#waiters.get(key)?.reject(error instanceof Error ? error : new Error(String(error)));
    this.#waiters.delete(key);
    void awaited.catch(() => undefined);
  }

  #onFrame(raw: unknown): void {
    let frame: ServerToClientFrame;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : '') as ServerToClientFrame;
    } catch {
      return;
    }
    if (!frame || typeof (frame as { t?: unknown }).t !== 'string') return;
    switch (frame.t) {
      case 'e2e':
        // The shared guard bounds every routing value before any of them is
        // used as a map key or decoded; this Client runs it rather than
        // trusting the relay to have (`docs/specs/server.md` → Relay).
        if (isE2eServerToClientFrame(frame)) this.#onE2e(frame);
        return;
      case 'host-gone':
        this.#disposeCeremony();
        this.#rejectAll(new Error('host disconnected'));
        this.#onHostGone?.();
        return;
      case 'error':
        // Fixed copy, for the reason the denial tables are: the text is the
        // relay's, unbounded and unshaped, and `#rejectAll` fails in-flight
        // protocol-v1 requests whose message the app renders verbatim — so a
        // hostile relay would be choosing the sentence the user reads. The
        // relay's own words go to the console instead.
        console.warn('[pocket] relay error frame', frame.error);
        this.#rejectAll(new Error(HOST_UNAVAILABLE_MESSAGE));
        return;
      default:
        // Every legacy frame is ignored: this Client speaks one protocol.
        return;
    }
  }

  #onE2e(frame: E2eServerToClientFrame): void {
    const established = this.#established;
    if (
      established &&
      frame.kind === 'connection' &&
      frame.id === established.connectionId &&
      frame.step === 'transport'
    ) {
      this.#onEstablishedFrame(established, frame.ct);
      return;
    }
    const key = waiterKey(frame.kind, frame.id, frame.step);
    const waiter = this.#waiters.get(key);
    if (!waiter) return; // an answer nobody is awaiting
    this.#waiters.delete(key);
    waiter.resolve(frame.ct);
  }

  /**
   * One transport frame on an authorized session. **Any decrypt or framing
   * failure ends it**: there is no resynchronization point in a stream cipher,
   * so a poisoned session is host loss and the app must leave the wall.
   */
  #onEstablishedFrame(established: EstablishedSession, ct: string): void {
    let receipt;
    try {
      receipt = established.session.receive(fromBase64Url(ct));
    } catch {
      this.#teardown('the end-to-end session failed', { notifyGone: true });
      return;
    }
    // A keepalive is accepted and ignored; a control message on an established
    // session is not part of protocol-v1 and says nothing this can act on.
    if (receipt.kind !== 'app') return;
    for (const message of receipt.messages) {
      let payload: unknown;
      try {
        payload = JSON.parse(utf8Decode(message));
      } catch {
        continue;
      }
      this.#onMsg(payload);
    }
  }

  #onMsg(data: unknown): void {
    const response = data as RemoteResponse;
    if (response && typeof response.requestId === 'string') {
      const pending = this.#pending.get(response.requestId);
      if (!pending) return;
      this.#pending.delete(response.requestId);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new Error(response.error ?? 'request failed'));
      return;
    }
    const event = data as RemoteEventMsg;
    if (event && typeof event.subId === 'string') {
      this.#events.get(event.subId)?.(event);
    }
  }

  #onClose(ws: PocketSocket): void {
    // Generation guard, and the whole test for "was this close intentional?":
    // `close()` tears down and nulls #ws *before* calling `ws.close()`, and a
    // reconnect overwrites #ws with the new socket, so neither an intentional
    // close nor a superseded socket's late close gets past this line. Anything
    // that does is the socket dying on us (server restart, network drop).
    if (this.#ws !== ws) return;
    // An unexpected drop of an established session is still host loss — the app
    // must leave the wall instead of idling on a dead stream — even without a
    // `host-gone` frame.
    this.#teardown('relay socket closed', { notifyGone: this.#connectedHostId !== null });
  }

  /**
   * Reset all socket-bound state and fail pending work. The one real difference
   * between an intentional {@link close} and an unexpected drop is whether to
   * fire `onHostGone`, made explicit here via `notifyGone`.
   */
  #teardown(reason: string, { notifyGone }: { notifyGone: boolean }): void {
    this.#ws = null; // never reuse a closed socket; openSocket() makes a fresh one
    this.#disposeCeremony();
    this.#rejectAll(new Error(reason));
    if (notifyGone) this.#onHostGone?.();
  }

  /** Erase every session's cipher state; a new ceremony starts from a handshake. */
  #disposeCeremony(): void {
    this.#stopKeepalives();
    this.#connectedHostId = null;
    this.#established = null;
  }

  /** Fail every awaited ceremony frame and in-flight request (avoids hangs). */
  #rejectAll(error: Error): void {
    for (const waiter of this.#waiters.values()) waiter.reject(error);
    this.#waiters.clear();
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  /**
   * A ceremony that failed before an outcome: relay error, dropped socket, or
   * expired timer, all of them {@link HOST_UNAVAILABLE_MESSAGE}.
   */
  #unavailable(error: unknown): { readonly ok: false; readonly message: string } {
    this.#disposeCeremony();
    if (error instanceof SessionExpiredError) throw error;
    return { ok: false, message: HOST_UNAVAILABLE_MESSAGE };
  }

  #connectionUnavailable(error: unknown): ConnectResult {
    return { ...this.#unavailable(error), pairingRequired: false };
  }

  async #api<T>(route: string, body?: unknown, init?: RequestInit): Promise<T> {
    const method = init?.method ?? 'POST';
    const response = await this.#fetch(`${this.#baseUrl}${route}`, {
      method,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      ...(method === 'GET' || method === 'DELETE' ? {} : { body: JSON.stringify(body ?? {}) }),
    });
    const parsed = (await response.json().catch(() => ({}))) as T & { error?: string };
    // Only the session gate's 401 means "sign in again" — a refused setup token
    // answers 401 too, and bouncing the user to sign-in for that would be a
    // worse bug than the one this fixes.
    if (response.status === 401 && parsed.error === UNAUTHORIZED_ERROR) {
      // Drop the token here rather than at the call site: every later request
      // and every relay upgrade would fail the same way, and keeping it would
      // let the UI believe it is still signed in.
      this.#sessionToken = null;
      throw new SessionExpiredError();
    }
    // A refusal, not a bare Error: an answer arrived, which is what `setup`
    // reads to decide whether the Server can be assumed to hold nothing.
    if (!response.ok) {
      throw new ServerRefusalError(
        parsed.error ?? `request failed (${response.status})`,
        response.status,
      );
    }
    return parsed;
  }

  /**
   * Turn a relay-socket failure into a {@link SessionExpiredError} when the
   * session is the reason. A rejected WS upgrade reaches the browser as a bare
   * `error` event with no status, so the only way to tell "session died" from
   * "network is down" is to ask an authenticated route — which answers the
   * question and costs one request on a path that has already failed.
   */
  async #diagnoseSocketFailure(original: Error): Promise<never> {
    if (this.#sessionToken === null) throw original;
    try {
      await this.#api<HostsResponse>(API_ROUTES.hosts, undefined, {
        method: 'GET',
        headers: { authorization: `Bearer ${this.#sessionToken}` },
      });
    } catch (err) {
      if (err instanceof SessionExpiredError) throw err;
      // Probe failed for its own reason — report the socket failure, which is
      // what the user actually hit.
    }
    throw original;
  }

  #requireToken(): string {
    if (!this.#sessionToken) throw new Error('sign in first');
    return this.#sessionToken;
  }

  #requireCredentialId(): string {
    const credentialId = this.#credentialId;
    if (!credentialId) throw new Error('sign in before pairing or connecting');
    return credentialId;
  }

  #requirePasskeyPublicKey(credentialId: string): string {
    const publicKey = this.#storage.getPasskeyPublicKey(credentialId);
    if (!publicKey) throw new Error(PASSKEY_UNAVAILABLE_MESSAGE);
    return publicKey;
  }
}

/** Where one ceremony's frames are addressed; the envelope's routing triple. */
interface E2eRoute {
  readonly kind: E2eKind;
  readonly id: string;
  readonly hostId: string;
}

/** A ceremony frame is awaited by its kind, its id, **and** its step. */
function waiterKey(kind: string, id: string, step: string): string {
  return `${kind}:${id}:${step}`;
}

/** Internal: a deadline expired with no answer. Never reaches the UI as itself. */
class HostUnavailableError extends Error {
  constructor() {
    super(HOST_UNAVAILABLE_MESSAGE);
    this.name = 'HostUnavailableError';
  }
}

function uuid(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * The browser's own visibility, as {@link PocketVisibility}.
 *
 * A runtime with no `document` — a test, a worker — reads as visible: the
 * alternative is a client that silently never keepalives, and the only place
 * this default runs is the app, which always has one.
 */
function documentVisibility(): PocketVisibility {
  const doc: Document | undefined = globalThis.document;
  return {
    isVisible: () => doc === undefined || doc.visibilityState === 'visible',
    subscribe(onChange) {
      if (!doc) return () => {};
      doc.addEventListener('visibilitychange', onChange);
      return () => doc.removeEventListener('visibilitychange', onChange);
    },
  };
}

/**
 * localStorage-backed {@link PocketStorage}, mirrored in memory so blocked site
 * data costs persistence and nothing else.
 *
 * Every localStorage touch is best-effort — a browser with site data blocked
 * (Safari's Lockdown/private modes, an enterprise policy) throws on `getItem`
 * and `setItem` alike, and `setup` caches the public key only once the
 * authenticator credential behind it exists. Left to throw, that failure would
 * strand the visit: the cache write blows up after the registration is already
 * irreversible, and every retry mints another orphan passkey.
 *
 * So the mirror is the primary copy — writes land there first, reads consult it
 * before storage — and localStorage is a cache that may silently do nothing.
 * Setup and sign-in then complete normally for the life of the tab; only
 * surviving a reload is lost.
 */
export function localStoragePocketStorage(): PocketStorage {
  const PASSKEY_PREFIX = 'dormouse-pocket:passkey:';
  const PUSH_ENDPOINT_KEY = 'dormouse-pocket:push-endpoint';

  const passkeys = new Map<string, string>();
  let pushEndpoint: string | undefined;

  const read = (key: string): string | null => {
    try {
      return globalThis.localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const write = (key: string, value: string): void => {
    try {
      globalThis.localStorage.setItem(key, value);
    } catch {
      // Persistence is the only casualty; the mirror already holds it.
    }
  };
  const drop = (key: string): void => {
    try {
      globalThis.localStorage.removeItem(key);
    } catch {
      // As above.
    }
  };

  return {
    getPasskeyPublicKey: (credentialId) =>
      passkeys.get(credentialId) ?? read(PASSKEY_PREFIX + credentialId),
    setPasskeyPublicKey: (credentialId, publicKey) => {
      passkeys.set(credentialId, publicKey);
      write(PASSKEY_PREFIX + credentialId, publicKey);
    },
    // No tombstone: the only key ever forgotten was written by this same run,
    // so storage holds it only if that write worked — in which case this
    // removal does too.
    forgetPasskeyPublicKey: (credentialId) => {
      passkeys.delete(credentialId);
      drop(PASSKEY_PREFIX + credentialId);
    },
    knownCredentialIds: () => {
      // Union, not either-or: storage holds earlier visits, the mirror holds
      // this one's writes. Blocked storage contributes nothing and the mirror
      // still answers.
      const ids = new Set(passkeys.keys());
      for (const key of keysWithPrefix(PASSKEY_PREFIX)) {
        ids.add(key.slice(PASSKEY_PREFIX.length));
      }
      return [...ids];
    },
    getRegisteredPushEndpoint: () => pushEndpoint ?? read(PUSH_ENDPOINT_KEY),
    setRegisteredPushEndpoint: (fingerprint) => {
      pushEndpoint = fingerprint;
      write(PUSH_ENDPOINT_KEY, fingerprint);
    },
  };
}

/**
 * The legacy per-Host markers, removed once per page life.
 *
 * `dormouse-pocket:paired:*` was the local guess the pre-end-to-end Hosts view
 * offered a button from; the `KnownHostV1` records replaced it, and a marker
 * left behind is a claim about authorization that nothing checks. Best-effort,
 * like every other touch of this storage.
 */
export function purgeLegacyPairedMarkers(): void {
  // Collected before removing: mutating while enumerating by index skips keys.
  const stale = keysWithPrefix('dormouse-pocket:paired:');
  try {
    for (const key of stale) globalThis.localStorage.removeItem(key);
  } catch {
    // Blocked or absent storage holds no markers to remove.
  }
}

/**
 * Every `localStorage` key under `prefix`, or none when the store cannot be
 * read at all — a browser with site data blocked throws on the property access
 * itself, not merely on `getItem`.
 */
function keysWithPrefix(prefix: string): string[] {
  const found: string[] = [];
  try {
    const store = globalThis.localStorage;
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key?.startsWith(prefix)) found.push(key);
    }
  } catch {
    // Nothing readable is nothing to report.
  }
  return found;
}
