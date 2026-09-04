/**
 * The wire contract for the selfhost POC (docs/specs/relay.md): HTTP routes
 * and payloads, relay frames, and the terminal-only remote-api v1 messages.
 * Shared by `server`, the Burrow module in `lib`, and the Pocket UI so the
 * three sides cannot drift — the same pattern as HELLO_ROUTE.
 */

import {
  base64UrlLength,
  isBoundedBase64Url,
  isBoundedString,
  isExactBase64Url,
} from '../security/bytes.js';
import { NOISE_MAX_MESSAGE_LENGTH } from '../security/noise.js';
import type { PasskeyAssertion } from '../security/passkey.js';
import type { PresenceBinding } from '../security/presence.js';
import type { SealedPushV1 } from '../security/push-seal.js';

// ---------------------------------------------------------------------------
// HTTP API (see relay.md "HTTP API")

export const API_ROUTES = {
  setupBegin: '/api/setup/begin',
  setupFinish: '/api/setup/finish',
  setupRetire: '/api/setup/retire',
  signinBegin: '/api/signin/begin',
  signinFinish: '/api/signin/finish',
  reauthBegin: '/api/reauth/begin',
  reauthFinish: '/api/reauth/finish',
  burrowEnroll: '/api/burrow/enroll',
  burrowSetupToken: '/api/burrow/setup-token',
  burrows: '/api/burrows',
  pushConfig: '/api/push/config',
  pushSubscribe: '/api/push/subscribe',
  pushSubscriptionsQuery: '/api/push/subscriptions/query',
  /**
   * The route *pattern* one delivery row is deleted at. The concrete path comes
   * from {@link pushSubscriptionDeletePath}, so the Relay's registration and
   * the client's fetch cannot spell the parameter differently.
   */
  pushSubscriptionDelete: '/api/push/subscriptions/:deliveryId',
  pushDevices: '/api/push/devices',
  pushSend: '/api/push/send',
} as const;

/**
 * `DELETE` path for one delivery row. The id is a bearer capability rather than
 * an enumerable identifier, so it rides the path and is percent-encoded here
 * even though base64url never needs it — one encoder, no caller deciding.
 */
export function pushSubscriptionDeletePath(deliveryId: string): string {
  return `/api/push/subscriptions/${encodeURIComponent(deliveryId)}`;
}

/**
 * The `error` a session-gated route answers 401 with when the session token is
 * unknown or expired. Shared because Pocket keys recovery on it: a 401 alone is
 * ambiguous (a spent setup token answers 401 too), and only this one means
 * "sign in again". Changing the string on one side without the other would
 * silently strand users on a dead session.
 */
export const UNAUTHORIZED_ERROR = 'unauthorized';

/**
 * The `error` the setup routes answer 401 with when a `setupToken` is mistyped,
 * unknown, expired, already spent, or was minted by a Burrow since revoked.
 * Distinct from {@link UNAUTHORIZED_ERROR} because Pocket keys recovery flows on
 * bodies and Pocket itself sends setup tokens: a spent one means "re-scan", not
 * "sign in again", and the shared string would drive the wrong recovery.
 */
export const SETUP_TOKEN_INVALID_ERROR = 'invalid setup token';

/**
 * The `error` `POST /api/burrow/enroll` answers 401 with when the *setup password*
 * was wrong, as against {@link UNAUTHORIZED_ERROR} for a rejected enroll token.
 * Shared for the same reason as its two siblings: the status alone is ambiguous
 * and the two have different recoveries — retype the password, or stop pressing
 * the installer's one-click offer and use the typed form. A Burrow that guessed
 * from the credential it happened to send would name the wrong one for a 401
 * raised by anything in front of the Relay.
 */
export const BAD_PASSWORD_ERROR = 'invalid setup password';

export const WS_ROUTES = {
  burrow: '/ws/burrow',
  client: '/ws/client',
} as const;

/** WS auth rides a query parameter (browsers cannot set WS headers). */
export const WS_TOKEN_PARAM = 'token';

/**
 * Close code the relay sends to a Burrow socket it displaces when a newer socket
 * claims the same `burrowId` (only one socket may own a burrowId — see relay.md
 * "Relay"). In the 4000-4999 application-private range.
 *
 * This lives on the wire contract rather than inside `server` because the Burrow
 * keys its reconnect policy on it: every other close is transient and gets
 * backoff-reconnected, but this one is deliberate and terminal, so the evicted
 * Burrow stands down instead of reconnecting. If the two sides disagreed on the
 * number, two Burrows would evict each other in an endless loop.
 */
export const WS_CLOSE_BURROW_REPLACED = 4000;

/** Human-readable reason paired with {@link WS_CLOSE_BURROW_REPLACED}. */
export const WS_CLOSE_BURROW_REPLACED_REASON = 'replaced by a newer burrow connection';

/**
 * The Burrow's `burrows.json` row is gone, so its bearer token names nothing.
 *
 * A distinct code from {@link WS_CLOSE_BURROW_REPLACED} because the two mean
 * opposite things to a reconnect: a replaced Burrow must stand down, while a
 * revoked one may retry as often as it likes — the upgrade will simply 401,
 * which is the whole of what revocation is.
 */
export const WS_CLOSE_BURROW_REVOKED = 4001;

/** Human-readable reason paired with {@link WS_CLOSE_BURROW_REVOKED}. */
export const WS_CLOSE_BURROW_REVOKED_REASON = 'this burrow is no longer enrolled';

/** The selfhost mode has exactly one account. */
export const SELFHOST_ACCOUNT_ID = 'owner';

/**
 * What gates the two setup routes: the single-use `token` of a
 * {@link SetupTokenResponse} an enrolled Burrow minted for its QR, and nothing
 * else. Registering a passkey therefore always begins at a code an enrolled
 * Burrow displayed; the setup password enrolls Burrows and no longer registers
 * anything ({@link BurrowEnrollRequest}).
 */
export interface SetupCredential {
  setupToken: string;
}

export type SetupBeginRequest = SetupCredential;
export interface SetupBeginResponse {
  /** Base64url challenge for `navigator.credentials.create()`. */
  challenge: string;
  rpId: string;
  accountId: string;
  /**
   * Base64url ids of the passkeys the account already holds, for the
   * registration's `excludeCredentials`. The Relay is the authority on what is
   * registered, so it is the only side that can answer this — a browser's own
   * cache is empty on a fresh install and cleared again by a refused `finish`.
   */
  existingCredentialIds: string[];
}

export type SetupFinishRequest = SetupCredential & {
  /** Base64url credential id (`PublicKeyCredential.id`). */
  credentialId: string;
  /** Base64url SPKI from `response.getPublicKey()`. */
  publicKey: string;
  /** Base64url `response.clientDataJSON` (type `webauthn.create`). */
  clientDataJSON: string;
  label: string;
};
export interface SetupFinishResponse {
  accountId: string;
  credentialId: string;
}

export interface SigninBeginResponse {
  /** Base64url challenge for `navigator.credentials.get()`. */
  challenge: string;
  rpId: string;
}

export interface SigninFinishRequest {
  assertion: PasskeyAssertion;
}
export interface SigninFinishResponse {
  /** Bearer token for `/api/burrows` and the `token` param of /ws/client. */
  sessionToken: string;
  accountId: string;
  expiresAt: number;
  /**
   * Base64url SPKI of the passkey that was just asserted.
   *
   * Returned so a browser that did not *register* this passkey can still pair
   * and connect: both requests carry the public key (as a hash for pairing, in
   * full for a connection), and without this the Client could only get it by
   * having performed the registration itself — which forced a second passkey
   * on every new browser profile, most visibly an iOS Home Screen install.
   *
   * Handing it out costs nothing. It is a *public* key the Burrow is given inside
   * every presence proof anyway, and possessing it authorizes nothing: a
   * connection still requires a fresh assertion, the Client static the Noise
   * handshake authenticated, and both halves on one active ACL record
   * (docs/specs/remote-security-model.md).
   */
  passkeyPublicKey: string;
}

/**
 * Mint the WebAuthn challenge for one ceremony's presence proof (session-token
 * auth). The binding is **required** and kind-tagged: the challenge is
 * `presenceChallenge(binding, relayNonce)`, so an assertion produced for one
 * pairing or connection authenticates nothing anywhere else
 * (`docs/specs/remote-security-model.md` → Presence proofs).
 *
 * The Relay learns only routing values and a handshake hash, which the relay
 * already sees, and the exchange extends nothing: the session's life and the
 * relay socket are untouched.
 */
export interface ReauthBeginRequest {
  binding: PresenceBinding;
}
export interface ReauthBeginResponse {
  /** Base64url `presenceChallenge(binding, relayNonce)`. */
  challenge: string;
  rpId: string;
  /** Single-use, short-TTL; echoed back by `finish` and carried in the proof. */
  relayNonce: string;
  /**
   * The one credential the ceremony may assert with — the binding's own. A
   * `get()` that could answer with any of the account's passkeys would let a
   * synced credential the Burrow never paired satisfy a proof bound to one it did.
   */
  allowCredentials: string[];
}

export interface ReauthFinishRequest {
  relayNonce: string;
  assertion: PasskeyAssertion;
}
export interface ReauthFinishResponse {
  /** Epoch ms the Relay verified this assertion at. */
  verifiedAt: number;
}

/**
 * Enroll a Burrow. Exactly one credential must be present — the setup password,
 * or the one-time `token` of an installer's `EnrollmentOffer` (enroll-offer.ts)
 * for a Burrow on the Relay's own machine. Both, or neither, is a 400.
 *
 * **No label.** The name a machine presents is its own, kept beside the
 * enrollment on the Burrow and told to a Client only inside an encrypted ceremony
 * outcome (`docs/specs/remote-security-model.md` → Burrow identity).
 */
export type BurrowEnrollRequest =
  | { password: string; enrollToken?: never }
  | { password?: never; enrollToken: string };
export interface BurrowEnrollResponse {
  burrowId: string;
  /** Bearer credential for the `token` param of /ws/burrow. */
  burrowToken: string;
  /** What the Burrow must enforce as its ConnectionPolicy. */
  origin: string;
  rpId: string;
  /**
   * Whether the Burrow must demand a user-verified assertion (biometric/PIN,
   * not merely presence).
   *
   * Optional and additive: an older Burrow reading a newer Relay's response
   * ignores it, and a newer Burrow reading an older Relay's sees `undefined`,
   * which is the same as `false`. It travels here rather than being
   * configured on the Burrow because the invariant is that the two sides
   * *mirror* — a Relay demanding UV while the Burrow does not means the Burrow is
   * the weaker verifier, and the Burrow is the one that decides access.
   */
  requireUserVerification?: boolean;
}

/**
 * Burrow-token auth. The single-use setup credential an enrolled Burrow mints for
 * its pairing QR: the token only, since the Burrow composes the URL itself from
 * the origin it enrolled against, and a URL minted Relay-side would be one
 * more place the deployment's own address is decided.
 *
 * **No mint handle.** Redemption at the Relay no longer flips anything on the
 * Burrow: the invitation the same QR carries is Burrow memory, and its state — not
 * the token's — is what the QR panel renders
 * (`docs/specs/remote-security-model.md` → Pairing). A phone that already holds
 * a session retires the token itself through `POST /api/setup/retire`.
 */
export interface SetupTokenResponse {
  token: string;
  /** Epoch ms after which the token no longer redeems. */
  expiresAt: number;
}

/**
 * Session auth. A signed-in phone that scanned a QR it will not register a
 * passkey with retires the token, so a photographed code cannot register one
 * afterwards. Answers 204, or 401 with {@link SETUP_TOKEN_INVALID_ERROR}.
 */
export interface SetupRetireRequest {
  setupToken: string;
}

/**
 * How many unspent setup tokens ONE Burrow may hold, capping both sides of the
 * credential: the Relay's issuer map and the Burrow's own map of the nonces it
 * paired with them. One constant, so live-on-one-side and spent-on-the-other
 * cannot drift. A human scans one at a time, so it is far above any real use.
 *
 * Source of truth for the eviction rule: `relay/src/setup-token.ts`.
 */
export const MAX_TOKENS_PER_BURROW = 8;

/**
 * The longest setup token this Burrow will put in a QR.
 *
 * A real one is base64url of 32 bytes (43 characters). The bound is what keeps
 * a 200 off a hostile or broken Relay from reaching the QR encoder, which
 * throws above its capacity — inside the app-wide ErrorBoundary, taking every
 * terminal down with it.
 */
const SETUP_TOKEN_MAX_LENGTH = 128;

/** Base64url, bounded, non-empty — the shape of a setup token on this wire. */
function isSetupTokenHandle(value: unknown): value is string {
  return isBoundedBase64Url(value, SETUP_TOKEN_MAX_LENGTH);
}

/**
 * Structural validation of a {@link SetupTokenResponse}, beside the type so a
 * field added here cannot be silently accepted by the Burrow that reads one.
 *
 * The Burrow runs it on the 200 body for the reason `isEnrollment` exists: a
 * Relay that answers 200 with `token` missing — a version skew, a proxy that
 * rewrote the body — would otherwise put `undefined` in the QR's URL. The
 * charset and length bounds are not hygiene: the token goes straight into a QR
 * encoder, and `expiresAt` straight into a `setTimeout` delay.
 */
export function isSetupTokenResponse(value: unknown): value is SetupTokenResponse {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    isSetupTokenHandle(candidate.token) &&
    typeof candidate.expiresAt === 'number' &&
    Number.isFinite(candidate.expiresAt) &&
    candidate.expiresAt > 0
  );
}

/**
 * Discovery only: which Burrows this account has enrolled, and which are
 * connected. **No label** — the Relay holds none, and a Client renders the one
 * its own pinned record carries (`docs/specs/pocket-app.md`).
 */
export interface BurrowsResponse {
  burrows: Array<{ burrowId: string; online: boolean }>;
}

// ---------------------------------------------------------------------------
// Web Push (see alert.md "Push notifications" and relay.md "HTTP API").
//
// Two audiences with different credentials: the Pocket Client registers, queries
// and deletes its own rows with a session token plus the `deliveryId` the Burrow
// minted for it; the Burrow reads and sends with its `burrowToken`. Rows are keyed
// on the PAIR (burrowId, deliveryId), so a Client subscribes once per Burrow it is
// paired with and a Burrow can only ever see or reach its own subscribers.
//
// **The delivery id is the proof.** It is 256 unguessable bits known only to
// the Burrow's ACL record and that Client's own pinned record, so possession is
// what authorizes registering, querying, and deleting — there is no challenge
// and no signature, and the Relay never lists ids to a session.

/** Public VAPID key, needed by the browser before it can subscribe. */
export interface PushConfigResponse {
  /** Base64url VAPID application server key, or null when push is unconfigured. */
  applicationServerKey: string | null;
}

/** The browser's `PushSubscription`, narrowed to what delivery needs. */
export interface PushSubscriptionPayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushSubscribeRequest {
  burrowId: string;
  /** Base64url of 32 bytes — the capability this Burrow minted for this Client. */
  deliveryId: string;
  subscription: PushSubscriptionPayload;
}
export interface PushSubscribeResponse {
  subscribedAt: number;
  /**
   * Every Burrow whose rows carry the presented endpoint after the mutation — the
   * state, not the delta. When *this* delivery's own row changes address, every
   * row still on the endpoint it replaced goes in the same mutation; a row for
   * some other delivery whose phone rotated without re-registering is left to
   * the provider's own 404/410 pruning, since the Relay holds no cross-Burrow
   * device identity that could link the two.
   *
   * Reporting the result rather than the event is what makes a lost response
   * self-healing: the idempotent retry cannot re-announce a deletion it already
   * performed, but it can always answer what is there now, so the Client needs
   * no memory of what it did.
   */
  burrowIds: string[];
}

/**
 * Session auth. Which of the caller's **own** delivery ids are registered, and
 * for which Burrow — the readback a reloaded Client uses instead of re-offering
 * Enable for every Burrow.
 *
 * Parameterized by capability rather than by identity: the caller must already
 * hold each id it asks about, so this is proof of possession rather than the
 * enumeration primitive a device-key parameter was.
 */
export interface PushSubscriptionsQueryRequest {
  deliveryIds: string[];
}
export interface PushSubscriptionsQueryResponse {
  /** Only rows matching a presented id, and only under the current VAPID key. */
  registered: Array<{ burrowId: string; deliveryId: string }>;
}

/**
 * The most delivery ids one request may name — a query's `deliveryIds`, and a
 * send's `recipients`. A browser holds one per paired Burrow and a Burrow has one
 * ACL record per paired Client, so this is far above any real use on either
 * route: what it buys the query is not being a bulk oracle, and what it buys
 * the send is a bound on the sealed envelopes one POST can carry.
 */
export const MAX_PUSH_QUERY_DELIVERY_IDS = 64;

/**
 * Burrow-token auth. Returns delivery ids only — the Burrow holds the ACL and is
 * the only side that can turn one into a human label, so the Relay never
 * learns one (docs/specs/remote-security-model.md).
 */
export interface PushDevicesResponse {
  devices: Array<{ deliveryId: string; subscribedAt: number }>;
}

/**
 * One recipient of a send: who to reach, and the envelope only they can open.
 *
 * Per recipient rather than one payload for the list, because the seal is to
 * that Client's own static — there is no group key and deliberately none
 * (`docs/specs/remote-security-model.md` -> Push sealing).
 */
export interface SealedPushRecipient {
  deliveryId: string;
  sealed: SealedPushV1;
}

/**
 * Burrow-token auth. `recipients` is required and non-empty: the Burrow holds the
 * ACL and is the only party that may decide who a push reaches, so the Relay
 * never selects recipients itself.
 *
 * **The Relay reads no notification text.** Title, body, and the per-Session
 * collapse tag are bounded on the Burrow, sealed, and re-sanitized in the service
 * worker at the render sink; what crosses this route is ciphertext plus a
 * delivery address ([alert.md](../../../docs/specs/alert.md) -> Push
 * notifications).
 */
export interface PushSendRequest {
  recipients: SealedPushRecipient[];
}

/**
 * What the Relay forwards to the push service, verbatim: the sealed envelope
 * plus the `burrowId` from the sending Burrow's own token, which is how the worker
 * picks the pinned record to decrypt against.
 */
export interface SealedPushPayload extends SealedPushV1 {
  burrowId: string;
}
/**
 * Wall-clock bound the send route holds one delivery attempt under, so a hung
 * push service cannot hold the handler open indefinitely
 * (`sendWithinDeadline` in `relay/src/push.ts`).
 *
 * Shared because it is the Burrow's contract too: this is how long the Relay may
 * legitimately take to answer `POST /api/push/send`, so the Burrow's own request
 * timeout has to sit *above* it or a delivery that succeeded reports as a
 * failure (`lib/src/remote/burrow/push-delivery.ts`).
 */
export const PUSH_SEND_DEADLINE_MS = 15_000;

export interface PushSendResponse {
  /** How many subscriptions accepted the push. */
  delivered: number;
  /** Subscriptions the push service rejected as gone; these are now dropped. */
  expired: number;
  /** Named delivery ids with no subscription for this Burrow. */
  unknown: number;
  /**
   * Deliveries the push service refused for a transient-looking reason; the
   * rows are kept. Reported so the Burrow can tell an all-failed fan-out from
   * success — the HTTP status is 200 either way.
   */
  failed: number;
}

// ---------------------------------------------------------------------------
// Relay frames (see relay.md "Relay"). One JSON frame per WS message.
// `clientId` is assigned by the Relay per client socket; the client itself
// never sees or sends it.

/**
 * Client → server: the end-to-end envelope, and nothing else. Anything the
 * relay cannot route is answered with an `error`.
 */
export type ClientFrame = E2eClientFrame;

/** Relay → client. */
export type RelayToClientFrame =
  | { t: 'burrow-gone' }
  | { t: 'error'; error: string }
  | E2eRelayToClientFrame;

/** Relay → burrow. Every frame addresses one Client by its Relay-assigned `clientId`. */
export type RelayToBurrowFrame = { t: 'client-gone'; clientId: string } | E2eRelayToBurrowFrame;

/** Burrow → server. */
export type BurrowFrame = E2eBurrowFrame;

// ---------------------------------------------------------------------------
// The `e2e` relay envelope: one end-to-end Noise message per frame, in a
// bounded routing envelope — the whole of what the relay routes
// (relay.md -> Relay).

/** Which ceremony a frame belongs to; a session is scoped to one kind and id. */
export type E2eKind = 'pairing' | 'connection';

/** A Client speaks message 1 (`init`), then transport. */
export type E2eClientStep = 'init' | 'transport';

/** A Burrow answers message 2 (`response`), then transport. */
export type E2eBurrowStep = 'response' | 'transport';

/**
 * Every routing id on this envelope — `burrowId`, `id`, `clientId` — is this many
 * bytes. Exported so a minter and {@link isE2eId} cannot drift: an id built at
 * any other length is one the shared guard silently refuses.
 */
export const E2E_ID_BYTE_LENGTH = 16;

/**
 * The invitation or connection id, base64url of 16 bytes. Exactly this long:
 * the id is a map key on both sides and appears in the prologue, so a variable
 * one would be a length the transcript does not pin.
 */
export const E2E_ID_LENGTH = base64UrlLength(E2E_ID_BYTE_LENGTH);

/**
 * The longest `ct` any `e2e` frame may carry: the base64url encoding of a
 * maximal Noise message. Computed from {@link NOISE_MAX_MESSAGE_LENGTH} so the
 * two cannot drift.
 */
export const MAX_E2E_CIPHERTEXT_LENGTH = base64UrlLength(NOISE_MAX_MESSAGE_LENGTH);

/**
 * The longest `clientId` a Burrow will act on. The relay mints these as base64url
 * of 16 random bytes; the headroom exists because the id is a *map key* on a
 * hostile-relay path — bounding every other field while leaving the key free
 * would bound only the part that was already bounded.
 */
export const MAX_CLIENT_ID_LENGTH = 256;

/**
 * The longest raw server → Burrow frame text a Burrow will hand to `JSON.parse`.
 *
 * Every other bound in this file is measured on a value the parser already
 * produced, so none of them is reached until the whole frame has been buffered
 * and parsed. The relay is assumed hostile and the Burrow is the process that
 * owns every PTY, so the parse itself needs a bound of its own: the largest
 * legal frame is one maximal ciphertext plus its routing fields, and the slack
 * covers the JSON punctuation, the two fixed-length ids, `t`/`kind`/`step`, and
 * any key ordering. Every legal field is ASCII, so this bounds bytes and UTF-16
 * code units alike and can also be handed to `ws` as `maxPayload`.
 */
export const MAX_SERVER_TO_BURROW_FRAME_LENGTH =
  MAX_E2E_CIPHERTEXT_LENGTH + MAX_CLIENT_ID_LENGTH + 512;

/** Client → server. */
export interface E2eClientFrame {
  t: 'e2e';
  burrowId: string;
  kind: E2eKind;
  id: string;
  step: E2eClientStep;
  /** One base64url Noise message. The relay never decodes it. */
  ct: string;
}

/** Relay → burrow: the Client's frame with the Relay-assigned `clientId`. */
export interface E2eRelayToBurrowFrame extends E2eClientFrame {
  clientId: string;
}

/** Burrow → server. */
export interface E2eBurrowFrame {
  t: 'e2e';
  clientId: string;
  kind: E2eKind;
  id: string;
  step: E2eBurrowStep;
  ct: string;
}

/** Relay → client: the Burrow's frame with `burrowId` stamped from its socket. */
export interface E2eRelayToClientFrame extends Omit<E2eBurrowFrame, 'clientId'> {
  burrowId: string;
}

export function isE2eKind(value: unknown): value is E2eKind {
  return value === 'pairing' || value === 'connection';
}

/** Base64url of exactly 16 bytes. */
export function isE2eId(value: unknown): value is string {
  return isExactBase64Url(value, E2E_ID_LENGTH);
}

/** Base64url, bounded by {@link MAX_E2E_CIPHERTEXT_LENGTH}, non-empty. */
export function isE2eCiphertext(value: unknown): value is string {
  return isBoundedBase64Url(value, MAX_E2E_CIPHERTEXT_LENGTH);
}

/**
 * The shape guard both a relay and a Burrow run on a Client-originated `e2e`
 * frame — the both-sides rule the relay and the Burrow share (relay.md ->
 * Relay). It cannot check the ciphertext, so all it enforces is that the
 * routing values are bounded. Pinned by `remote-lib-common/test/wire.test.mjs`
 * and, against real relay-minted ids, `relay/test/e2e-relay.test.mjs`.
 */
export function isE2eClientFrame(value: unknown): value is E2eClientFrame {
  if (!value || typeof value !== 'object') return false;
  const frame = value as Record<string, unknown>;
  return (
    frame.t === 'e2e' &&
    // A `burrowId` is minted the same way an invitation or connection id is, so
    // one length rule covers every routing id the Client puts on an envelope.
    isE2eId(frame.burrowId) &&
    isE2eKind(frame.kind) &&
    isE2eId(frame.id) &&
    (frame.step === 'init' || frame.step === 'transport') &&
    isE2eCiphertext(frame.ct)
  );
}

/**
 * {@link isE2eClientFrame} plus the relay-stamped `clientId` a Burrow reads. The
 * free `clientId` bound runs first: the ciphertext scan it would otherwise
 * follow costs ~33 µs on a maximal `ct`, and a hostile relay can send those at
 * line rate.
 */
export function isE2eRelayToBurrowFrame(value: unknown): value is E2eRelayToBurrowFrame {
  return (
    isBoundedString((value as { clientId?: unknown } | null)?.clientId, MAX_CLIENT_ID_LENGTH) &&
    isE2eClientFrame(value)
  );
}

/**
 * The shape guard a **Client** runs on what the relay hands it — the mirror of
 * {@link isE2eRelayToBurrowFrame}, and run for the same reason: the Client does
 * not trust the relay to have bounded anything, and every value here is a map
 * key or a base64url decode away from being work.
 */
export function isE2eRelayToClientFrame(value: unknown): value is E2eRelayToClientFrame {
  if (!value || typeof value !== 'object') return false;
  const frame = value as Record<string, unknown>;
  return (
    frame.t === 'e2e' &&
    isE2eId(frame.burrowId) &&
    isE2eKind(frame.kind) &&
    isE2eId(frame.id) &&
    (frame.step === 'response' || frame.step === 'transport') &&
    isE2eCiphertext(frame.ct)
  );
}

/** The shape guard a relay runs on a Burrow-originated `e2e` frame. */
export function isE2eBurrowFrame(value: unknown): value is E2eBurrowFrame {
  if (!value || typeof value !== 'object') return false;
  const frame = value as Record<string, unknown>;
  return (
    frame.t === 'e2e' &&
    isBoundedString(frame.clientId, MAX_CLIENT_ID_LENGTH) &&
    isE2eKind(frame.kind) &&
    isE2eId(frame.id) &&
    (frame.step === 'response' || frame.step === 'transport') &&
    isE2eCiphertext(frame.ct)
  );
}

// ---------------------------------------------------------------------------
// Remote-api v1, terminal-only (see remote-api.md "v1 scope" and relay.md).
// These ride as application messages on an authorized Noise session.

export interface RemoteRequest {
  requestId: string;
  method: string;
  params?: unknown;
}
export interface RemoteResponse {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}
export interface RemoteEventMsg {
  subId: string;
  event: string;
  data: unknown;
}

export const REMOTE_METHODS = {
  hello: 'hello',
  directoryWatch: 'directory.watch',
  surfaceAttach: 'surface.attach',
  surfaceDetach: 'surface.detach',
  terminalWrite: 'terminal.write',
  terminalResize: 'terminal.resize',
} as const;

// Events are dispatched by name, so future events (size-authority notify,
// per-attachment semantics — staged in remote-api.md ## Future) land here
// additively; old clients ignore names they don't know.
export const REMOTE_EVENTS = {
  directorySnapshot: 'directory.snapshot',
  terminalData: 'terminal.data',
  terminalClosed: 'terminal.closed',
} as const;

export interface HelloParams {
  protocolVersion: 1;
  viewer: 'phone' | 'vr' | 'desktop';
}
export interface HelloResult {
  protocolVersion: 1;
  burrowId: string;
  grants: { input: boolean; layout: boolean };
}

/** Terminal-only for the POC: no browser entries, so no `url`. */
export interface DirectoryEntry {
  paneRef: string;
  surfaceId: string;
  type: 'terminal';
  title: string;
  focused: boolean;
  activity?: 'unknown' | 'prompt' | 'editing' | 'running' | 'finished';
  exitCode?: number;
  /**
   * The pane's PTY process is still alive. A registry surface whose process has
   * exited (Dormouse keeps it open showing "[Process exited…]" until closed)
   * reports `alive: false` — distinct from `exitCode`, which is the last
   * shell-integration command's status, not process lifetime.
   */
  alive: boolean;
  cwd?: string;
  ringing: boolean;
  hasTODO: boolean;
}
export interface DirectorySnapshot {
  entries: DirectoryEntry[];
}

export interface AttachParams {
  surfaceId: string;
  cols: number;
  rows: number;
}
export interface TerminalAttachResult {
  cols: number;
  rows: number;
}

export interface TerminalDataEvent {
  /**
   * Base64url of the UTF-8 *renderer* projection — Dormouse-processed and
   * renderer-unparsed, so it is what the Burrow's own xterm writes, not raw PTY
   * output.
   */
  bytes: string;
  /**
   * Base64url of the UTF-8 text projection: the same chunk with string-control
   * payloads removed, for a consumer reading output as text. Omitted means
   * identical to `bytes`; present is authoritative, an empty string included.
   * Additive on protocol-v1 — an older Client that ignores it falls back to
   * `bytes`, which is what it always used.
   */
  text?: string;
}
export interface TerminalClosedEvent {
  exitCode?: number;
}

export interface TerminalWriteParams {
  surfaceId: string;
  /** Base64url input bytes. */
  bytes: string;
}
export interface TerminalResizeParams {
  surfaceId: string;
  cols: number;
  rows: number;
}

/**
 * The largest terminal dimension a remote peer may ask for.
 *
 * Far past any real display — a 4K screen at an unreadably small font is on
 * the order of 800 columns — and small enough that the worst case a peer can
 * request is a few million cells rather than an arbitrary number of them.
 */
export const MAX_TERMINAL_DIMENSION = 2000;

/**
 * Coerce a requested terminal dimension (cols or rows) to a positive integer,
 * falling back to `fallback` when the value is absent or not finite. Shared so
 * the Burrow api, the client adapter, and the test harness all sanitize sizes the
 * same way.
 *
 * Clamped at **both** ends, and the upper bound is the security-relevant half:
 * a local resize is derived from element geometry and cannot be large, but
 * `terminal.resize` carries a peer-supplied number straight to `term.resize`
 * in the webview that owns the pane, and xterm bounds only the minimum before
 * allocating `rows × cols` cells. Unbounded, one frame asking for a million by
 * a million wedges every terminal in that window — reachable by any authorized
 * Client (`docs/specs/security-remote.md` -> "Trust boundary").
 */
export function clampTerminalDimension(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_TERMINAL_DIMENSION, Math.max(1, Math.floor(value)));
}
