/**
 * UI-free Pocket protocol client. It speaks exactly one wire: the `e2e`
 * envelope of `docs/specs/relay.md` → "Routing", carrying the two end-to-end
 * ceremonies of `docs/specs/remote-security-model.md` (Pairing, Connection) and
 * — once a connection is established — protocol-v1 as application messages on
 * the same Noise session (`docs/specs/remote-api.md` owns their correlation).
 *
 * There is no plaintext path, no fallback, and no runtime selector: a Burrow that
 * cannot complete a ceremony is a Burrow this Client cannot reach.
 *
 * This file owns the relay socket and its envelope, the account plane, the
 * pinned Burrows, and the two ceremonies; what a ceremony's frames and an
 * established session do — protocol-v1, the direct path, keepalives — is
 * {@link ClientSessionCore}'s.
 */

import {
  API_ROUTES,
  DEFAULT_CHALLENGE_TTL_MS,
  DEFAULT_PAIRING_TTL_MS,
  DIRECT_ONLY_DEADLINE_MS,
  E2E_ID_BYTE_LENGTH,
  MAX_PUSH_QUERY_DELIVERY_IDS,
  NoiseTransportSession,
  SETUP_TOKEN_INVALID_ERROR,
  UNAUTHORIZED_ERROR,
  WS_ROUTES,
  WS_TOKEN_PARAM,
  createNoiseInitiator,
  e2eConnectionPrologue,
  fromBase64Url,
  hashPasskeyPublicKey,
  isConnectionOutcomeV1,
  isE2eRelayToClientFrame,
  isNoisePublicKey,
  isPairingOutcomeV1,
  pairingInvitationPrologue,
  pushEndpointFingerprint,
  pushSubscriptionDeletePath,
  randomBase64Url,
  samplePairingCode,
  toBase64Url,
  type ConnectionDenialCode,
  type ConnectionRequestV1,
  type DirectPath,
  type DirectRelayCause,
  type DirectoryEntry,
  type E2eClientFrame,
  type E2eClientStep,
  type E2eKind,
  type HelloResult,
  type BurrowsResponse,
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
  type RelayToClientFrame,
  type SetupBeginResponse,
  type SetupFinishResponse,
  type SigninBeginResponse,
  type SigninFinishResponse,
  type TerminalAttachResult,
} from 'remote-lib-common';
import {
  PasskeyAlreadyRegisteredError,
  isPasskeyAlreadyRegistered,
  type PasskeyRegistration,
  type WebAuthnClient,
} from './webauthn';
import {
  type KnownBurrowStore,
  type KnownBurrowV1,
  type KnownBurrowSummary,
  type PendingDeletionStore,
} from './pocket-db';
import { SCAN_LABEL } from '../setup-copy';
import { RelayHeartbeat, realTimer, type RemoteTimer, type RemoteWebSocket } from '../ws';
import {
  ClientSessionCore,
  networkNotAllowedMessage,
  type ClientSessionCoreDeps,
  type DirectWaitFailure,
} from './session-core';
import type { TerminalHandlers } from './remote-adapter';

/** The slice of a WebSocket the client uses; a browser `WebSocket` satisfies it. */
export type PocketSocket = RemoteWebSocket;

/**
 * Persistent per-device state that is *not* an end-to-end identity — those live
 * in IndexedDB ({@link KnownBurrowStore}). Passkey public keys are cached by
 * credential id at registration *and* at sign-in — the Relay returns the
 * asserted key — so any browser profile holding a synced passkey can build a
 * presence proof, not only the one that performed the registration.
 */
export interface PocketStorage {
  getPasskeyPublicKey(credentialId: string): string | null;
  setPasskeyPublicKey(credentialId: string, publicKey: string): void;
  /**
   * Drop a cached key again. Only {@link PocketClient.setup} calls it, for a
   * credential it cached moments earlier and the Relay then refused, so it
   * never has an older visit's key to lose.
   */
  forgetPasskeyPublicKey(credentialId: string): void;
  /** Credential ids this device has stored a public key for (may be empty). */
  knownCredentialIds(): string[];
  /**
   * Digest of the delivery address last registered with the Relay, or null if
   * this device has never registered one. Per device, not per Burrow: one
   * service-worker scope holds one subscription, so if it rotates, every Burrow
   * row for this device is stale at once.
   */
  getRegisteredPushEndpoint(): string | null;
  setRegisteredPushEndpoint(fingerprint: string): void;
}

/**
 * What a `PocketClient` is built from. The session core's own seams —
 * `setTimer`, `visibility`, `createDirectPeer` — pass straight through to it;
 * the relay socket's heartbeat arms on the same `setTimer` and runs on the
 * core's visibility.
 */
export interface PocketClientDeps
  extends Pick<ClientSessionCoreDeps<E2eRoute>, 'setTimer' | 'visibility' | 'createDirectPeer'> {
  /** Prepended to API routes; `''` for same-origin (the served app). */
  readonly baseUrl?: string;
  /** Base for the `/ws/client` URL, e.g. `wss://host`; derived from origin in the app. */
  readonly wsBase: string;
  readonly fetch: typeof fetch;
  readonly webauthn: WebAuthnClient;
  readonly createWebSocket: (url: string) => PocketSocket;
  /** The pinned per-Burrow records: this Client's whole authorization state. */
  readonly knownBurrows: KnownBurrowStore;
  /** Delivery ids owed a deletion; see {@link PocketClient.retirePendingDeletions}. */
  readonly pendingDeletions: PendingDeletionStore;
  readonly storage?: PocketStorage;
  readonly now?: () => number;
}

/**
 * A failure the Relay *answered* with — any response it rejected — as opposed
 * to a request that never got an answer at all (DNS, TLS, the radio), which
 * leaves `fetch`'s own `TypeError` to propagate untouched. The distinction is
 * load-bearing exactly once, in {@link PocketClient.setup}: it decides whether
 * the Relay can be assumed to hold nothing.
 */
export class RelayRefusalError extends Error {
  /**
   * The HTTP status behind the refusal, `0` where none was read.
   *
   * Carried because "the Relay answered" and "the Relay answered *this*" are
   * different facts, and a caller that acts on a refusal usually means one
   * status: a 404 is proof the Relay holds nothing, while a 400, a 401, or a
   * 502 is a refusal of this attempt and proof of nothing at all.
   */
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = 'RelayRefusalError';
    this.status = status;
  }
}

/**
 * Shown when the Burrow reaped this session while the page was backgrounded.
 * Not a failure — the price of the Burrow being able to reclaim state a hostile
 * relay would otherwise never let it reclaim (`docs/specs/pocket-app.md`).
 */
export const BURROW_SESSION_REAPED_MESSAGE =
  'This phone was away too long, so the computer let the session go. Connect again to resume.';

/**
 * What a connection the computer holds to the direct path reports when no
 * direct path formed in time, or the computer ended it without naming this
 * phone's address; a goodbye that names it reads
 * {@link networkNotAllowedMessage} instead (`docs/specs/remote-network.md` ->
 * "Local networks"). **Never tells the phone to join a network**: the computer
 * may be the end that was off them.
 */
export const DIRECT_ONLY_FAILED_MESSAGE =
  'This computer accepts phones only over a direct connection on a network it allows, and one couldn’t be made. ' +
  'Check that this phone and the computer are both on one of those networks, then Connect again.';

/**
 * What the same connection reports when a direct connection was never
 * possible: this browser brings no WebRTC, or the computer declined the offer.
 * Joining another network would not help, so this never says to.
 */
export const DIRECT_ONLY_UNSUPPORTED_MESSAGE =
  'This computer accepts phones only over a direct connection, and this browser or the computer can’t make one. ' +
  'Try another browser on this phone, or check the computer’s Settings → Network.';

/**
 * The fixed copy for a direct-only connect that never went direct: no direct
 * connection was possible at all, or one was and did not form.
 */
function directOnlyFailureMessage(failure: Exclude<DirectWaitFailure, 'retired'>): string {
  return failure === 'unsupported' || failure === 'declined'
    ? DIRECT_ONLY_UNSUPPORTED_MESSAGE
    : DIRECT_ONLY_FAILED_MESSAGE;
}

/** What a request in flight fails with when the computer ends the session on purpose. */
export const BURROW_SESSION_ENDED_MESSAGE = 'The computer ended this session. Connect again to resume.';

/** Shown when the Relay no longer accepts our session token. */
export const SESSION_EXPIRED_MESSAGE = 'Your session expired. Sign in again to continue.';

/**
 * The Relay rejected our session token, so nothing works until the user signs
 * in again. Distinct from an ordinary failure because the UI must react rather
 * than report: sessions live only in the Relay's memory (docs/specs/relay.md),
 * so they die on a 12h expiry *and* on every Relay restart, and an installed
 * Pocket has no address bar to reload from. Left as a message, the user is
 * stuck holding a dead token with force-quitting the app as the only way out.
 *
 * {@link PocketClient} clears the token before throwing this, so recovery is
 * exactly "sign in again" with the passkey cache and the pinned Burrows intact.
 */
export class SessionExpiredError extends RelayRefusalError {
  constructor() {
    super(SESSION_EXPIRED_MESSAGE, 401);
    this.name = 'SessionExpiredError';
  }
}

/** Shown when the scanned code is expired, spent, or otherwise unknown. */
export const SETUP_CODE_DEAD_MESSAGE =
  'That setup code has expired. Show a new one on the computer and scan it again.';

/**
 * The Relay refused the `setupToken` off a scanned code
 * ({@link SETUP_TOKEN_INVALID_ERROR}). Its own class for the reason
 * {@link SessionExpiredError} is: the UI must react rather than report — drop
 * the dead code and send the user back to the computer for a fresh one — and
 * the Relay answers 401 for an unknown session too, so only the body
 * separates them ({@link SETUP_CODE_DEAD_MESSAGE} is what the user reads).
 */
export class SetupTokenInvalidError extends RelayRefusalError {
  constructor() {
    super(SETUP_CODE_DEAD_MESSAGE, 401);
    this.name = 'SetupTokenInvalidError';
  }
}

/** Shown when a Burrow presents a static this Client has already pinned differently. */
export const BURROW_IDENTITY_MISMATCH_MESSAGE =
  'This computer is presenting a different identity than the one this phone paired with. ' +
  'Pairing was stopped. Remove it from this phone only if you know why it changed.';

/**
 * The Burrow answered a pairing with a static that is not the one already pinned
 * for that `burrowId`. Terminal, and the old record is left exactly as it was:
 * the pin is what a connection authenticates against, so replacing it on the
 * word of the party that failed the compare would be the whole attack
 * (`docs/specs/remote-security-model.md` → Pairing).
 */
export class BurrowIdentityMismatchError extends Error {
  constructor() {
    super(BURROW_IDENTITY_MISMATCH_MESSAGE);
    this.name = 'BurrowIdentityMismatchError';
  }
}

export const PASSKEY_UNAVAILABLE_MESSAGE =
  "This app no longer has the signed-in passkey's public key, so it cannot pair or connect. " +
  'Sign in again to restore it.';

/** Missing cached proof material requires a fresh sign-in, just like expiry. */
export class PasskeyUnavailableError extends Error {
  constructor() {
    super(PASSKEY_UNAVAILABLE_MESSAGE);
    this.name = 'PasskeyUnavailableError';
  }
}

/**
 * What the user reads for each Burrow-sent denial.
 *
 * **Fixed copy, never Burrow- or relay-supplied text.** The outcome is
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
  'burrow-error': 'The computer could not finish pairing. Show a new code and scan it again.',
};

export const CONNECTION_DENIAL_MESSAGES: Record<ConnectionDenialCode, string> = {
  'pairing-required': 'This computer no longer recognizes this phone. Scan a new code to pair again.',
  'presence-rejected': 'The computer could not verify your passkey. Sign in again and try Connect.',
  'protocol-rejected': 'The computer refused this connection.',
  'burrow-busy': 'The computer is already handling as many phones as it can. Try again shortly.',
  'burrow-error': 'The computer could not finish the connection.',
};

/**
 * What a ceremony that simply never answered reports.
 *
 * **A timer expiring is unavailability, not a denial.** A Burrow that is asleep,
 * a relay that dropped the frame, and a person who never looked at the laptop
 * are indistinguishable from here, and calling any of them a refusal would send
 * the user to fix the wrong thing.
 */
export const BURROW_UNAVAILABLE_MESSAGE =
  'The computer did not answer. Check that it is awake and connected, then try again.';

/** Fixed local-read recovery copy: browser errors can contain private details. */
export const CONNECTION_RECORD_UNREADABLE_MESSAGE =
  'This browser could not read the saved pairing record. '
  + `Try again, or use ${SCAN_LABEL} to pair again with fresh approval. `
  + 'Diagnostics: /diagnostics/index.html.';

/** Where a pairing ended, as the UI reports it. */
export type PairingResult =
  | { readonly ok: true; readonly record: KnownBurrowV1 }
  | { readonly ok: false; readonly message: string };

/** Where a connection attempt ended, as the UI reports it. */
export type ConnectResult =
  | { readonly ok: true; readonly burrowLabel: string }
  | { readonly ok: false; readonly message: string; readonly pairingRequired: boolean };

export class PocketClient {
  readonly #baseUrl: string;
  readonly #wsBase: string;
  readonly #fetch: typeof fetch;
  readonly #webauthn: WebAuthnClient;
  readonly #createWebSocket: (url: string) => PocketSocket;
  readonly #knownBurrows: KnownBurrowStore;
  readonly #pendingDeletions: PendingDeletionStore;
  readonly #storage: PocketStorage;
  readonly #now: () => number;
  readonly #setTimer: RemoteTimer;
  /** Everything a ceremony's frames and an established session do. */
  readonly #core: ClientSessionCore<E2eRoute>;
  /** Whether a direct-only connect is waiting for its switch, reporting its endings itself. */
  #awaitingDirect = false;

  #ws: PocketSocket | null = null;
  /** The open relay socket's heartbeat, or null while none is open. */
  #heartbeat: RelayHeartbeat | null = null;
  /**
   * The sign-in session: its token, and the account the Relay answered with
   * it — `'owner'` from a self-host Relay, the account's user id from Hosted.
   * Every presence proof names that account, and a pairing outcome must.
   */
  #session: { readonly token: string; readonly accountId: string } | null = null;
  /** The credential id from the most recent sign-in (or registration). */
  #credentialId: string | null = null;

  constructor(deps: PocketClientDeps) {
    this.#baseUrl = deps.baseUrl ?? '';
    this.#wsBase = deps.wsBase;
    this.#fetch = deps.fetch;
    this.#webauthn = deps.webauthn;
    this.#createWebSocket = deps.createWebSocket;
    this.#knownBurrows = deps.knownBurrows;
    this.#pendingDeletions = deps.pendingDeletions;
    this.#storage = deps.storage ?? localStoragePocketStorage();
    this.#now = deps.now ?? (() => Date.now());
    this.#setTimer = deps.setTimer ?? realTimer;
    this.#core = new ClientSessionCore<E2eRoute>({
      sendFrame: (route, step, ciphertext) => this.#sendE2e(route, step, ciphertext),
      messages: {
        unavailable: BURROW_UNAVAILABLE_MESSAGE,
        reaped: BURROW_SESSION_REAPED_MESSAGE,
        ended: BURROW_SESSION_ENDED_MESSAGE,
      },
      now: this.#now,
      setTimer: deps.setTimer,
      visibility: deps.visibility,
      createDirectPeer: deps.createDirectPeer,
    });
  }

  get sessionToken(): string | null {
    return this.#session?.token ?? null;
  }

  /** The signed-in session's account, or `null` signed out. */
  get accountId(): string | null {
    return this.#session?.accountId ?? null;
  }

  get connectedBurrowId(): string | null {
    return this.#core.establishedRoute?.burrowId ?? null;
  }

  /** See {@link ClientSessionCore.transportPath}. */
  get transportPath(): DirectPath {
    return this.#core.transportPath;
  }

  /** See {@link ClientSessionCore.setOnTransportChanged}. */
  setOnTransportChanged(
    callback: ((path: DirectPath, cause: DirectRelayCause | null) => void) | null,
  ): void {
    this.#core.setOnTransportChanged(callback);
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
   * Notified when the Burrow drops: a `burrow-gone` frame, a closed socket, a
   * session the Burrow's idle reaper took while this page was hidden, or the
   * Burrow's goodbye — the person at the computer took a pane back.
   *
   * **Never while a direct-only {@link connect} waits for its switch**: no wall
   * has mounted to leave, and that connect resolves the failure itself — one
   * report per ending.
   */
  setOnBurrowGone(callback: ((endedByBurrow: boolean) => void) | null): void {
    this.#core.setOnBurrowGone(
      callback &&
        ((endedByBurrow) => {
          if (!this.#awaitingDirect) callback(endedByBurrow);
        }),
    );
  }

  // --- Account: first-time setup + sign-in ---------------------------------

  /**
   * First-time setup: passkey registration gated by the single-use `setupToken`
   * off a scanned setup code. Follow with {@link signin}.
   */
  async setup({ setupToken }: { setupToken: string }, label: string): Promise<SetupFinishResponse> {
    const begin = await this.#setupApi<SetupBeginResponse>(API_ROUTES.setupBegin, { setupToken });
    // Excluded from the Relay's list, not this browser's: a retry — after a
    // refusal, or on a device that stored nothing — must not silently mint a
    // duplicate of a credential the account already holds, while an orphan the
    // Relay never registered is absent from it and is replaced as it should be.
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
      // same way. It is actionable: the list came from the Relay, so the
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
      // A refusal is proof the Relay has nothing; a lost answer is not. So a
      // rejected `finish` (a dead `setupToken`, any answered error) takes the
      // cache back down — kept, it would make `hasPriorUse` promise a sign-in
      // that cannot succeed — while an unanswered one leaves it standing.
      if (err instanceof RelayRefusalError) {
        this.#storage.forgetPasskeyPublicKey(registration.credentialId);
      }
      throw err;
    }
    // Only once the Relay has acknowledged it: this names the credential a
    // pairing's presence proof is built from. Sign-in refreshes it.
    this.#credentialId = registration.credentialId;
    return finish;
  }

  /**
   * Spend a scanned setup token without registering anything.
   *
   * A phone that is already signed in has no passkey to create, and a code left
   * redeemable is one a photograph of the laptop's screen could still register
   * with (`docs/specs/relay.md` → Setup tokens).
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
    this.#session = { token: finish.sessionToken, accountId: finish.accountId };
    this.#credentialId = assertion.credentialId;
    // Signing in is enough to pair from here. The Relay returns the asserted
    // passkey's public key, so a browser profile that never performed the
    // registration — an iOS Home Screen install, a second browser — can still
    // build presence proofs instead of being pushed into creating a redundant
    // second passkey.
    this.#storage.setPasskeyPublicKey(assertion.credentialId, finish.passkeyPublicKey);
    return finish;
  }

  async listBurrows(): Promise<BurrowsResponse['burrows']> {
    const response = await this.#api<BurrowsResponse>(API_ROUTES.burrows, undefined, {
      method: 'GET',
      ...this.#auth(),
    });
    return response.burrows;
  }

  // --- The pinned Burrows ----------------------------------------------------

  /** Every Burrow this browser holds a record for, paired or not. */
  listKnownBurrows(): Promise<KnownBurrowSummary[]> {
    return this.#knownBurrows.listSummaries();
  }

  /**
   * Forget one Burrow locally: the tombstone is written *before* the record that
   * holds the delivery id is deleted, so an unreachable Relay cannot strand a
   * push row nothing can name again.
   */
  async forgetBurrow(burrowId: string): Promise<void> {
    const record = await this.#knownBurrows.getSummary(burrowId);
    if (record?.authorization.state === 'paired') {
      await this.#tombstone(burrowId, record.authorization.deliveryId);
    }
    await this.#knownBurrows.delete(burrowId);
    await this.retirePendingDeletions();
  }

  // --- Web Push ------------------------------------------------------------

  /**
   * The VAPID public key a browser needs before it can subscribe, or `null`
   * when the Relay has push disabled. Unauthenticated — the key is public by
   * construction.
   */
  async getPushConfig(): Promise<string | null> {
    const response = await this.#api<PushConfigResponse>(API_ROUTES.pushConfig, undefined, {
      method: 'GET',
    });
    return response.applicationServerKey;
  }

  /**
   * The Burrows **this device** is already registered to receive push from.
   *
   * Asked by capability rather than by identity: the query names this browser's
   * own delivery ids and the Relay reports only on those, so there is no
   * endpoint that reports on a row the caller does not already hold the
   * capability for (`docs/specs/relay.md` → Web Push).
   */
  async listPushSubscribedBurrows(): Promise<string[]> {
    const deliveryIds = (await this.#knownBurrows.listSummaries())
      .flatMap((record) =>
        record.authorization.state === 'paired' ? [record.authorization.deliveryId] : [],
      )
      // The route refuses more than this, and a browser holding that many
      // paired Burrows has bigger problems than a truncated readback.
      .slice(0, MAX_PUSH_QUERY_DELIVERY_IDS);
    if (deliveryIds.length === 0) return [];
    const response = await this.#api<PushSubscriptionsQueryResponse>(
      API_ROUTES.pushSubscriptionsQuery,
      { deliveryIds },
      this.#auth(),
    );
    return response.registered.map((row) => row.burrowId);
  }

  /**
   * Register a browser push subscription against `burrowId`, presenting the
   * delivery id that Burrow minted for this Client at pairing. Possession of the
   * id is the whole authorization — there is no challenge and no signature.
   */
  async subscribeToPush(
    burrowId: string,
    subscription: PushSubscriptionPayload,
  ): Promise<PushSubscribeResponse> {
    const record = await this.#knownBurrows.getSummary(burrowId);
    if (record?.authorization.state !== 'paired') {
      throw new Error('this phone is not paired with that computer');
    }
    const result = await this.#api<PushSubscribeResponse>(
      API_ROUTES.pushSubscribe,
      { burrowId, deliveryId: record.authorization.deliveryId, subscription },
      this.#auth(),
    );
    // Recorded only once the Relay has the row: this is a note about what the
    // Relay holds, not about what the browser minted.
    this.#storage.setRegisteredPushEndpoint(await pushEndpointFingerprint(subscription.endpoint));
    return result;
  }

  /** Idempotent, and the Relay always answers 204. */
  async deletePushSubscription(deliveryId: string): Promise<void> {
    await this.#api<unknown>(pushSubscriptionDeletePath(deliveryId), undefined, {
      method: 'DELETE',
      ...this.#auth(),
    });
  }

  /**
   * Drain the tombstone queue, clearing each entry only on a Relay answer.
   *
   * Best-effort and never throws: its callers are boot, sign-in, and the step
   * before registering a replacement, none of which may fail over a deletion
   * that can simply be retried on the next one.
   */
  async retirePendingDeletions(): Promise<void> {
    if (this.#session === null) return;
    let queued;
    try {
      queued = await this.#pendingDeletions.list();
    } catch {
      return;
    }
    for (const tombstone of queued) {
      try {
        await this.deletePushSubscription(tombstone.deliveryId);
        await this.#pendingDeletions.delete(tombstone.burrowId, tombstone.deliveryId);
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
    const token = this.#requireSession().token;
    const url = `${this.#wsBase}${WS_ROUTES.client}?${WS_TOKEN_PARAM}=${encodeURIComponent(token)}`;
    const ws = this.#createWebSocket(url);
    this.#ws = ws;
    const isCurrent = () => this.#ws === ws;
    ws.addEventListener('message', (ev) => {
      if (!isCurrent()) return;
      const data = (ev as { data?: unknown }).data;
      if (this.#heartbeat?.read(data)) return;
      this.#onFrame(data);
    });
    ws.addEventListener('close', () => this.#onClose(ws));
    return new Promise((resolve, reject) => {
      ws.addEventListener('open', () => {
        if (!isCurrent()) {
          reject(new Error('relay socket superseded'));
          return;
        }
        this.#startHeartbeat(ws);
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
   * The per-Burrow static is minted here and held only in memory until the Burrow
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
    const { burrowId, inviteId } = invitation;
    const route = { kind: 'pairing', id: inviteId, burrowId } as const;
    const clientStatic = await this.#knownBurrows.generateKey(burrowId);
    const handshake = await createNoiseInitiator({
      prologue: pairingInvitationPrologue(invitation),
      staticKeyPair: clientStatic,
      remoteStaticPublicKey: invitation.ephPub,
    });
    const message1 = await handshake.writeMessage();
    let session: NoiseTransportSession;
    try {
      const response = await this.#core.exchange(route, message1, deadline);
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
      burrowId,
      handshakeHash,
      passkeyCredentialId,
    });
    const request: PairingRequestV1 = { code, label, presence };
    let outcome: unknown;
    try {
      outcome = await this.#core.exchangeControl(route, session, { ...request }, deadline);
    } catch (err) {
      return this.#unavailable(err);
    }
    if (!isPairingOutcomeV1(outcome)) {
      return { ok: false, message: PAIRING_DENIAL_MESSAGES['burrow-error'] };
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
      outcome.accountId !== this.#session?.accountId ||
      outcome.passkeyCredentialId !== passkeyCredentialId ||
      outcome.passkeyPublicKeyHash !== passkeyPublicKeyHash ||
      !isNoisePublicKey(outcome.burrowStaticPublicKey)
    ) {
      return { ok: false, message: PAIRING_DENIAL_MESSAGES['burrow-error'] };
    }
    const existing = await this.#knownBurrows.getSummary(burrowId);
    if (existing && existing.burrowStaticPublicKey !== outcome.burrowStaticPublicKey) {
      // Terminal, and the old record is untouched — see BurrowIdentityMismatchError.
      throw new BurrowIdentityMismatchError();
    }
    // A re-pair mints a fresh delivery id, so the one this record is about to
    // forget has to be queued before the write that forgets it.
    if (
      existing?.authorization.state === 'paired' &&
      existing.authorization.deliveryId !== outcome.deliveryId
    ) {
      await this.#tombstone(burrowId, existing.authorization.deliveryId);
    }
    const record: KnownBurrowV1 = {
      burrowId,
      accountId: outcome.accountId,
      label: outcome.burrowLabel,
      burrowStaticPublicKey: outcome.burrowStaticPublicKey,
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
    await this.#knownBurrows.put(record);
    return { ok: true, record };
  }

  // --- Connection ----------------------------------------------------------

  /**
   * Connect to a paired Burrow: IK against the pinned static, one presence proof
   * over this handshake's own transcript, and the Burrow's single outcome
   * (`docs/specs/remote-security-model.md` → Connection).
   */
  async connect(burrowId: string): Promise<ConnectResult> {
    await this.#ensureSocket();
    let record: KnownBurrowV1 | null;
    try {
      record = await this.#knownBurrows.get(burrowId);
    } catch {
      // A local read failure is not an authenticated revocation. Preserve the
      // pin and delivery capability, and never expose browser exception text.
      return {
        ok: false,
        message: CONNECTION_RECORD_UNREADABLE_MESSAGE,
        pairingRequired: false,
      };
    }
    if (!record) {
      return { ok: false, message: CONNECTION_DENIAL_MESSAGES['pairing-required'], pairingRequired: true };
    }
    if (record.authorization.state !== 'paired') {
      return { ok: false, message: CONNECTION_DENIAL_MESSAGES['pairing-required'], pairingRequired: true };
    }
    const deadline = this.#now() + DEFAULT_CHALLENGE_TTL_MS;
    const connectionId = randomBase64Url(E2E_ID_BYTE_LENGTH);
    const route = { kind: 'connection', id: connectionId, burrowId } as const;
    const handshake = await createNoiseInitiator({
      prologue: e2eConnectionPrologue(burrowId, connectionId),
      staticKeyPair: {
        privateKey: record.clientStaticKeyPair.privateKey,
        publicKey: fromBase64Url(record.clientStaticKeyPair.publicKeyRaw),
      },
      remoteStaticPublicKey: fromBase64Url(record.burrowStaticPublicKey),
    });
    let session: NoiseTransportSession;
    let burrowChallenge: string;
    try {
      const response = await this.#core.exchange(route, await handshake.writeMessage(), deadline);
      // Message 2's payload is the Burrow's fresh single-use challenge, which the
      // presence binding must name.
      burrowChallenge = toBase64Url(await handshake.readMessage(fromBase64Url(response)));
      session = new NoiseTransportSession(handshake.session);
    } catch (err) {
      return this.#connectionUnavailable(err);
    }
    const presence = await this.#provePresence({
      kind: 'connection',
      burrowId,
      connectionId,
      burrowChallenge,
      handshakeHash: toBase64Url(session.handshakeHash),
      passkeyCredentialId: record.passkeyCredentialId,
    });
    // **A second Connect on one Client replaces the first**, the mirror of
    // `BurrowRuntime.#promoteConnection`: its predecessor's endpoint, peer and
    // channel go, and left alive the orphan's channel would report violations
    // against *this* session. The Burrow closes that channel at promotion, and
    // on a direct path that close travels peer-to-peer while the outcome
    // travels over the relay — so it can arrive first, and `rejectAll` would
    // fail the waiter registered on the next line.
    //
    // **Here and no earlier.** Only the connection request can reach
    // `#promoteConnection`, so nothing before this line can close the old
    // channel — and a presence proof the user cancels, or a handshake that
    // throws, must leave a working session exactly as it was.
    if (this.#core.establishedRoute) this.#core.endSession('connection replaced', { notifyGone: false });
    let outcome: unknown;
    try {
      const request: ConnectionRequestV1 = { presence };
      outcome = await this.#core.exchangeControl(route, session, { ...request }, deadline);
    } catch (err) {
      return this.#connectionUnavailable(err);
    }
    if (!isConnectionOutcomeV1(outcome)) {
      return { ok: false, message: CONNECTION_DENIAL_MESSAGES['burrow-error'], pairingRequired: false };
    }
    if (outcome.ok) {
      // After the outcome and never before: `establish` builds the direct
      // path, and a peer connection that existed ahead of authorization would
      // be one an unauthorized party had steered.
      this.#core.establish(route, session);
      // **A direct-only session sends no protocol-v1 before the switch**: the
      // Burrow ends one whose application message crosses the relay, so the
      // wall mounts only once the direct path carries both directions.
      let failure: DirectWaitFailure | null = null;
      if (outcome.directOnly === true) {
        // A replacing Connect retires this wait before its own request goes
        // out, so this one is over long before that one's outcome arrives.
        this.#awaitingDirect = true;
        try {
          failure = await this.#core.awaitDirect(DIRECT_ONLY_DEADLINE_MS);
        } finally {
          this.#awaitingDirect = false;
        }
      }
      if (failure !== null) {
        // A replacing Connect retired this one, and its session is the live
        // one now: answered without touching it.
        if (failure === 'retired') return { ok: false, message: BURROW_UNAVAILABLE_MESSAGE, pairingRequired: false };
        const message =
          (failure === 'ended-by-burrow' ? networkNotAllowedMessage(this.#core.goodbye) : null) ??
          directOnlyFailureMessage(failure);
        if (this.#core.establishedRoute === route) this.#core.endSession(message, { notifyGone: false });
        return { ok: false, message, pairingRequired: false };
      }
      return { ok: true, burrowLabel: outcome.burrowLabel };
    }
    if (outcome.code === 'pairing-required') {
      // Best-effort: the outcome is authenticated and the row has to move to
      // *Pair again* whatever the local stores do. A tombstone write that
      // throws leaves the record `paired`, which is the safe half — the next
      // Connect earns the same authenticated denial and retries this.
      try {
        await this.#dropAuthorization(record);
      } catch {
        this.#core.disposeSession();
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
  async #dropAuthorization(record: KnownBurrowV1): Promise<void> {
    if (record.authorization.state !== 'paired') return;
    const { deliveryId } = record.authorization;
    await this.#tombstone(record.burrowId, deliveryId);
    await this.#knownBurrows.put({ ...record, authorization: { state: 'pairing-required' } });
    // Best-effort: the tombstone is what makes this retryable, so a failure
    // here costs a later drain rather than the row.
    try {
      await this.deletePushSubscription(deliveryId);
      await this.#pendingDeletions.delete(record.burrowId, deliveryId);
    } catch {
      // Left queued.
    }
    this.#core.disposeSession();
  }

  async #tombstone(burrowId: string, deliveryId: string): Promise<void> {
    await this.#pendingDeletions.put({ burrowId, deliveryId, queuedAt: this.#now() });
  }

  // --- Remote-api v1 (see ClientSessionCore) --------------------------------

  hello(): Promise<HelloResult> {
    return this.#core.hello();
  }

  watchDirectory(onSnapshot: (entries: DirectoryEntry[]) => void): Promise<string> {
    return this.#core.watchDirectory(onSnapshot);
  }

  attach(
    surfaceId: string,
    cols: number,
    rows: number,
    handlers: TerminalHandlers,
  ): Promise<{ subId: string; result: TerminalAttachResult }> {
    return this.#core.attach(surfaceId, cols, rows, handlers);
  }

  write(surfaceId: string, bytes: string): Promise<unknown> {
    return this.#core.write(surfaceId, bytes);
  }

  resize(surfaceId: string, cols: number, rows: number): Promise<unknown> {
    return this.#core.resize(surfaceId, cols, rows);
  }

  detach(surfaceId: string, subId?: string): Promise<unknown> {
    return this.#core.detach(surfaceId, subId);
  }

  unsubscribe(subId: string): void {
    this.#core.unsubscribe(subId);
  }

  /** See {@link ClientSessionCore.sendKeepalive}. */
  sendKeepalive(): void {
    this.#core.sendKeepalive();
  }

  close(): void {
    const ws = this.#ws;
    // Tear down BEFORE closing the socket: nulling #ws is what makes #onClose's
    // generation guard reject the close that follows, which is the only thing
    // keeping an intentional close from firing `burrow-gone`. Real sockets emit
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
    return { headers: { authorization: `Bearer ${this.#requireSession().token}` } };
  }

  /**
   * One WebAuthn assertion, bound to this ceremony and to nothing else
   * (`docs/specs/remote-security-model.md` → Presence proofs).
   *
   * **One authenticator prompt per proof, never cached and never reused.** The
   * challenge is derived from the binding, so an assertion produced here
   * authenticates no other pairing or connection; the Relay's `finish` proves
   * nothing to the Burrow, which recomputes the challenge and verifies the same
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
      { relayNonce: begin.relayNonce, assertion },
      auth,
    );
    return {
      binding,
      relayNonce: begin.relayNonce,
      accountId: this.#requireSession().accountId,
      passkeyCredentialId: binding.passkeyCredentialId,
      passkeyPublicKey: this.#requirePasskeyPublicKey(binding.passkeyCredentialId),
      assertion,
    };
  }

  /**
   * One `e2e` envelope. Every Client→Burrow byte goes through here — the
   * session core's too, as its `sendFrame`.
   */
  #sendE2e(route: E2eRoute, step: E2eClientStep, ciphertext: Uint8Array): void {
    this.#send({
      t: 'e2e',
      burrowId: route.burrowId,
      kind: route.kind,
      id: route.id,
      step,
      ct: toBase64Url(ciphertext),
    });
  }

  #send(frame: E2eClientFrame): void {
    if (!this.#ws) throw new Error('relay socket is not open');
    this.#ws.send(JSON.stringify(frame));
  }

  #onFrame(raw: unknown): void {
    let frame: RelayToClientFrame;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : '') as RelayToClientFrame;
    } catch {
      return;
    }
    if (!frame || typeof (frame as { t?: unknown }).t !== 'string') return;
    switch (frame.t) {
      case 'e2e':
        // The shared guard bounds every routing value before any of them is
        // used as a map key or decoded; this Client runs it rather than
        // trusting the relay to have (`docs/specs/relay.md` → "Routing").
        if (isE2eRelayToClientFrame(frame)) this.#core.onFrame(frame, frame.step, frame.ct);
        return;
      case 'burrow-gone':
        this.#core.loseBurrow('burrow disconnected');
        return;
      case 'error':
        // Fixed copy, for the reason the denial tables are: the text is the
        // relay's, unbounded and unshaped, and `rejectAll` fails in-flight
        // protocol-v1 requests whose message the app renders verbatim — so a
        // hostile relay would be choosing the sentence the user reads. The
        // relay's own words go to the console instead.
        console.warn('[pocket] relay error frame', frame.error);
        this.#core.rejectAll(new Error(BURROW_UNAVAILABLE_MESSAGE));
        return;
      default:
        // Every legacy frame is ignored: this Client speaks one protocol.
        return;
    }
  }

  /**
   * Ping the relay socket while the page is visible, on the session core's
   * visibility as keepalives run (`docs/specs/relay.md` → "Routing"); a socket that
   * stops answering is a drop, though no close arrived.
   */
  #startHeartbeat(ws: PocketSocket): void {
    this.#stopHeartbeat();
    this.#heartbeat = new RelayHeartbeat(ws, this.#setTimer, () => {
      this.#onClose(ws);
      try {
        ws.close();
      } catch {
        // already closing
      }
    });
    this.#core.setSocketHeartbeat(this.#heartbeat);
  }

  #stopHeartbeat(): void {
    this.#heartbeat?.stop();
    this.#heartbeat = null;
    this.#core.setSocketHeartbeat(null);
  }

  #onClose(ws: PocketSocket): void {
    // Generation guard, and the whole test for "was this close intentional?":
    // `close()` tears down and nulls #ws *before* calling `ws.close()`, and a
    // reconnect overwrites #ws with the new socket, so neither an intentional
    // close nor a superseded socket's late close gets past this line. Anything
    // that does is the socket dying on us (server restart, network drop).
    if (this.#ws !== ws) return;
    // An unexpected drop of an established session is still burrow loss — the app
    // must leave the wall instead of idling on a dead stream — even without a
    // `burrow-gone` frame.
    this.#teardown('relay socket closed', { notifyGone: this.connectedBurrowId !== null });
  }

  /**
   * Reset all socket-bound state and fail pending work. The one real difference
   * between an intentional {@link close} and an unexpected drop is whether to
   * fire `onBurrowGone`, made explicit here via `notifyGone`.
   */
  #teardown(reason: string, { notifyGone }: { notifyGone: boolean }): void {
    this.#ws = null; // never reuse a closed socket; openSocket() makes a fresh one
    this.#stopHeartbeat();
    this.#core.endSession(reason, { notifyGone });
  }

  /**
   * A ceremony that failed before an outcome: relay error, dropped socket, or
   * expired timer, all of them {@link BURROW_UNAVAILABLE_MESSAGE}.
   */
  #unavailable(error: unknown): { readonly ok: false; readonly message: string } {
    this.#core.disposeSession();
    if (error instanceof SessionExpiredError) throw error;
    return { ok: false, message: BURROW_UNAVAILABLE_MESSAGE };
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
      this.#session = null;
      throw new SessionExpiredError();
    }
    // A refusal, not a bare Error: an answer arrived, which is what `setup`
    // reads to decide whether the Relay can be assumed to hold nothing.
    if (!response.ok) {
      throw new RelayRefusalError(
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
    if (this.#session === null) throw original;
    try {
      await this.#api<BurrowsResponse>(API_ROUTES.burrows, undefined, {
        method: 'GET',
        headers: { authorization: `Bearer ${this.#session.token}` },
      });
    } catch (err) {
      if (err instanceof SessionExpiredError) throw err;
      // Probe failed for its own reason — report the socket failure, which is
      // what the user actually hit.
    }
    throw original;
  }

  #requireSession(): { readonly token: string; readonly accountId: string } {
    if (!this.#session) throw new Error('sign in first');
    return this.#session;
  }

  #requireCredentialId(): string {
    const credentialId = this.#credentialId;
    if (!credentialId) throw new Error('sign in before pairing or connecting');
    return credentialId;
  }

  #requirePasskeyPublicKey(credentialId: string): string {
    const publicKey = this.#storage.getPasskeyPublicKey(credentialId);
    if (!publicKey) {
      this.#session = null;
      throw new PasskeyUnavailableError();
    }
    return publicKey;
  }
}

/** Where one ceremony's frames are addressed; the envelope's routing triple. */
interface E2eRoute {
  readonly kind: E2eKind;
  readonly id: string;
  readonly burrowId: string;
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
 * The legacy per-Burrow markers, removed once per page life.
 *
 * `dormouse-pocket:paired:*` was the local guess the pre-end-to-end Burrows view
 * offered a button from; the `KnownBurrowV1` records replaced it, and a marker
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
