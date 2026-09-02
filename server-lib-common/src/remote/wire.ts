/**
 * The wire contract for the selfhost POC (docs/specs/server.md): HTTP routes
 * and payloads, relay frames, and the terminal-only remote-api v1 messages.
 * Shared by `server`, the Host module in `lib`, and the Pocket UI so the
 * three sides cannot drift — the same pattern as HELLO_ROUTE.
 */

import type { HostAclRecord } from '../security/acl.js';
import {
  base64UrlLength,
  isBoundedBase64Url,
  isBoundedString,
  isExactBase64Url,
} from '../security/bytes.js';
import type { ConnectionFailure, ConnectionRequest } from '../security/connection.js';
import { NOISE_MAX_MESSAGE_LENGTH } from '../security/noise.js';
import type { PairStatusQuery, PairingRequest } from '../security/pairing.js';
import type { PasskeyAssertion } from '../security/passkey.js';
import type { PresenceBinding } from '../security/presence.js';

// ---------------------------------------------------------------------------
// HTTP API (see server.md "HTTP API")

export const API_ROUTES = {
  setupBegin: '/api/setup/begin',
  setupFinish: '/api/setup/finish',
  setupRetire: '/api/setup/retire',
  signinBegin: '/api/signin/begin',
  signinFinish: '/api/signin/finish',
  reauthBegin: '/api/reauth/begin',
  reauthFinish: '/api/reauth/finish',
  hostEnroll: '/api/host/enroll',
  hostSetupToken: '/api/host/setup-token',
  hosts: '/api/hosts',
  pushConfig: '/api/push/config',
  pushSubscribe: '/api/push/subscribe',
  pushSubscriptionsQuery: '/api/push/subscriptions/query',
  /**
   * The route *pattern* one delivery row is deleted at. The concrete path comes
   * from {@link pushSubscriptionDeletePath}, so the server's registration and
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
 * ambiguous (a wrong setup password and a rejected device signature also answer
 * 401), and only this one means "sign in again". Changing the string on one
 * side without the other would silently strand users on a dead session.
 */
export const UNAUTHORIZED_ERROR = 'unauthorized';

/**
 * The `error` the setup routes answer 401 with when a `setupToken` is mistyped,
 * unknown, expired, already spent, or was minted by a Host since revoked.
 * Distinct from {@link UNAUTHORIZED_ERROR} because Pocket keys recovery flows on
 * bodies and Pocket itself sends setup tokens: a spent one means "re-scan", not
 * "sign in again", and the shared string would drive the wrong recovery.
 */
export const SETUP_TOKEN_INVALID_ERROR = 'invalid setup token';

export const WS_ROUTES = {
  host: '/ws/host',
  client: '/ws/client',
} as const;

/** WS auth rides a query parameter (browsers cannot set WS headers). */
export const WS_TOKEN_PARAM = 'token';

/**
 * Close code the relay sends to a Host socket it displaces when a newer socket
 * claims the same `hostId` (only one socket may own a hostId — see server.md
 * "Relay"). In the 4000-4999 application-private range.
 *
 * This lives on the wire contract rather than inside `server` because the Host
 * keys its reconnect policy on it: every other close is transient and gets
 * backoff-reconnected, but this one is deliberate and terminal, so the evicted
 * Host stands down instead of reconnecting. If the two sides disagreed on the
 * number, two Hosts would evict each other in an endless loop.
 */
export const WS_CLOSE_HOST_REPLACED = 4000;

/** Human-readable reason paired with {@link WS_CLOSE_HOST_REPLACED}. */
export const WS_CLOSE_HOST_REPLACED_REASON = 'replaced by a newer host connection';

/** The selfhost mode has exactly one account. */
export const SELFHOST_ACCOUNT_ID = 'owner';

/**
 * What gates the two setup routes: the setup password, or the single-use
 * `token` of a {@link SetupTokenResponse} an enrolled Host minted for its QR.
 * Exactly one must be present — both, or neither, is a 400 (why: `pickCredential`
 * in `server/src/app.ts`), the same rule as {@link HostEnrollRequest}.
 */
export type SetupCredential =
  | { password: string; setupToken?: never }
  | { password?: never; setupToken: string };

export type SetupBeginRequest = SetupCredential;
export interface SetupBeginResponse {
  /** Base64url challenge for `navigator.credentials.create()`. */
  challenge: string;
  rpId: string;
  accountId: string;
  /**
   * Base64url ids of the passkeys the account already holds, for the
   * registration's `excludeCredentials`. The Server is the authority on what is
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
  /** Bearer token for `/api/hosts` and the `token` param of /ws/client. */
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
   * Handing it out costs nothing. It is a *public* key the Host is given in
   * every `ConnectionRequest` anyway, and possessing it authorizes nothing: a
   * connection still requires a fresh assertion, a device-key signature, and
   * both halves on one active ACL record (docs/specs/remote-security-model.md).
   */
  passkeyPublicKey: string;
}

/**
 * Mint the WebAuthn challenge for one ceremony's presence proof (session-token
 * auth). The binding is **required** and kind-tagged: the challenge is
 * `presenceChallenge(binding, serverNonce)`, so an assertion produced for one
 * pairing or connection authenticates nothing anywhere else
 * (`docs/specs/remote-security-model.md` → Presence proofs).
 *
 * The Server learns only routing values and a handshake hash, which the relay
 * already sees, and the exchange extends nothing: the session's life and the
 * relay socket are untouched.
 */
export interface ReauthBeginRequest {
  binding: PresenceBinding;
}
export interface ReauthBeginResponse {
  /** Base64url `presenceChallenge(binding, serverNonce)`. */
  challenge: string;
  rpId: string;
  /** Single-use, short-TTL; echoed back by `finish` and carried in the proof. */
  serverNonce: string;
  /**
   * The one credential the ceremony may assert with — the binding's own. A
   * `get()` that could answer with any of the account's passkeys would let a
   * synced credential the Host never paired satisfy a proof bound to one it did.
   */
  allowCredentials: string[];
}

export interface ReauthFinishRequest {
  serverNonce: string;
  assertion: PasskeyAssertion;
}
export interface ReauthFinishResponse {
  /** Epoch ms the Server verified this assertion at. */
  verifiedAt: number;
}

/**
 * Enroll a Host. Exactly one credential must be present — the setup password,
 * or the one-time `token` of an installer's `EnrollmentOffer` (enroll-offer.ts)
 * for a Host on the server's own machine. Both, or neither, is a 400.
 */
export type HostEnrollRequest = { label: string } & (
  | { password: string; enrollToken?: never }
  | { password?: never; enrollToken: string }
);
export interface HostEnrollResponse {
  hostId: string;
  /** Bearer credential for the `token` param of /ws/host. */
  hostToken: string;
  /** What the Host must enforce as its ConnectionPolicy. */
  origin: string;
  rpId: string;
  /**
   * Whether the Host must demand a user-verified assertion (biometric/PIN,
   * not merely presence).
   *
   * Optional and additive: an older Host reading a newer server's response
   * ignores it, and a newer Host reading an older server's sees `undefined`,
   * which is the same as `false`. It travels here rather than being
   * configured on the Host because the invariant is that the two sides
   * *mirror* — a Server demanding UV while the Host does not means the Host is
   * the weaker verifier, and the Host is the one that decides access.
   */
  requireUserVerification?: boolean;
}

/**
 * Host-token auth. The single-use setup credential an enrolled Host mints for
 * its pairing QR: the token only, since the Host composes the URL itself from
 * the origin it enrolled against, and a URL minted server-side would be one
 * more place the deployment's own address is decided.
 *
 * **No mint handle.** Redemption at the Server no longer flips anything on the
 * Host: the invitation the same QR carries is Host memory, and its state — not
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
 * How many unspent setup tokens ONE Host may hold, capping both sides of the
 * credential: the Server's issuer map and the Host's own map of the nonces it
 * paired with them. One constant, so live-on-one-side and spent-on-the-other
 * cannot drift. A human scans one at a time, so it is far above any real use.
 *
 * Source of truth for the eviction rule: `server/src/setup-token.ts`.
 */
export const MAX_TOKENS_PER_HOST = 8;

/**
 * The longest setup token this Host will put in a QR.
 *
 * A real one is base64url of 32 bytes (43 characters). The bound is what keeps
 * a 200 off a hostile or broken server from reaching the QR encoder, which
 * throws above its capacity — inside the app-wide ErrorBoundary, taking every
 * terminal down with it.
 */
const SETUP_TOKEN_MAX_LENGTH = 128;

/**
 * The `#setup` hash a Host composes for its QR and Pocket parses at boot; one
 * owner so the emitter and the parser cannot drift. `docs/specs/server.md` ->
 * Setup tokens owns the grammar.
 */
export const SETUP_HASH_PREFIX = '#setup?';
export const SETUP_HASH_TOKEN_PARAM = 'token';
export const SETUP_HASH_NONCE_PARAM = 'nonce';

/**
 * Base64url, bounded, non-empty — the shape of every handle on this wire, and
 * of both halves of the QR hash above.
 */
export function isSetupTokenHandle(value: unknown): value is string {
  return isBoundedBase64Url(value, SETUP_TOKEN_MAX_LENGTH);
}

/**
 * Structural validation of a {@link SetupTokenResponse}, beside the type so a
 * field added here cannot be silently accepted by the Host that reads one.
 *
 * The Host runs it on the 200 body for the reason `isEnrollment` exists: a
 * server that answers 200 with `token` missing — a version skew, a proxy that
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

export interface HostsResponse {
  hosts: Array<{ hostId: string; label: string; online: boolean }>;
}

// ---------------------------------------------------------------------------
// Web Push (see alert.md "Push notifications" and server.md "HTTP API").
//
// Two audiences with different credentials: the Pocket Client registers, queries
// and deletes its own rows with a session token plus the `deliveryId` the Host
// minted for it; the Host reads and sends with its `hostToken`. Rows are keyed
// on the PAIR (hostId, deliveryId), so a Client subscribes once per Host it is
// paired with and a Host can only ever see or reach its own subscribers.
//
// **The delivery id is the proof.** It is 256 unguessable bits known only to
// the Host's ACL record and that Client's own pinned record, so possession is
// what authorizes registering, querying, and deleting — there is no challenge
// and no signature, and the Server never lists ids to a session.

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
  hostId: string;
  /** Base64url of 32 bytes — the capability this Host minted for this Client. */
  deliveryId: string;
  subscription: PushSubscriptionPayload;
}
export interface PushSubscribeResponse {
  subscribedAt: number;
  /**
   * Every Host whose rows carry the presented endpoint after the mutation — the
   * state, not the delta. When *this* delivery's own row changes address, every
   * row still on the endpoint it replaced goes in the same mutation; a row for
   * some other delivery whose phone rotated without re-registering is left to
   * the provider's own 404/410 pruning, since the Server holds no cross-Host
   * device identity that could link the two.
   *
   * Reporting the result rather than the event is what makes a lost response
   * self-healing: the idempotent retry cannot re-announce a deletion it already
   * performed, but it can always answer what is there now, so the Client needs
   * no memory of what it did.
   */
  hostIds: string[];
}

/**
 * Session auth. Which of the caller's **own** delivery ids are registered, and
 * for which Host — the readback a reloaded Client uses instead of re-offering
 * Enable for every Host.
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
  registered: Array<{ hostId: string; deliveryId: string }>;
}

/**
 * The most delivery ids one query may name. A browser holds one per paired
 * Host, so this is far above any real use and is what keeps the route from
 * being a bulk oracle.
 */
export const MAX_PUSH_QUERY_DELIVERY_IDS = 64;

/**
 * Host-token auth. Returns delivery ids only — the Host holds the ACL and is
 * the only side that can turn one into a human label, so the Server never
 * learns one (docs/specs/remote-security-model.md).
 */
export interface PushDevicesResponse {
  devices: Array<{ deliveryId: string; subscribedAt: number }>;
}

/**
 * Host-token auth. `deliveryIds` is required and non-empty: the Host holds the
 * ACL and is the only party that may decide who a push reaches, so the Server
 * never selects recipients itself.
 *
 * Reserved: the payload is still plaintext `title`/`body`/`tag`. Stage 6 of
 * **Scope: e2e-client-host** (`docs/specs/remote-security-model.md` →
 * `## Future`, "Sealed push") replaces it with the sealed envelope; nothing
 * else about this route changes then.
 */
export interface PushSendRequest {
  deliveryIds: string[];
  title: string;
  body: string;
  /**
   * Collapse key. The alarm path tags per Session so a Pane that rings, is
   * cleared, and rings again replaces its own notification instead of stacking
   * copies on the lock screen.
   */
  tag?: string;
}
/**
 * Wall-clock bound the send route holds one delivery attempt under, so a hung
 * push service cannot hold the handler open indefinitely
 * (`sendWithinDeadline` in `server/src/push.ts`).
 *
 * Shared because it is the Host's contract too: this is how long the Server may
 * legitimately take to answer `POST /api/push/send`, so the Host's own request
 * timeout has to sit *above* it or a delivery that succeeded reports as a
 * failure (`lib/src/remote/host/push-delivery.ts`).
 */
export const PUSH_SEND_DEADLINE_MS = 15_000;

export interface PushSendResponse {
  /** How many subscriptions accepted the push. */
  delivered: number;
  /** Subscriptions the push service rejected as gone; these are now dropped. */
  expired: number;
  /** Named delivery ids with no subscription for this Host. */
  unknown: number;
  /**
   * Deliveries the push service refused for a transient-looking reason; the
   * rows are kept. Reported so the Host can tell an all-failed fan-out from
   * success — the HTTP status is 200 either way.
   */
  failed: number;
}

// ---------------------------------------------------------------------------
// Relay frames (see server.md "Relay"). One JSON frame per WS message.
// `clientId` is assigned by the server per client socket; the client itself
// never sees or sends it.

/**
 * Client → server. `msg` is only forwarded once the session is authorized.
 *
 * `pair-status` is the one frame that does **not** bind the client to the host
 * it names: it asks a question about the ACL, and asking must not tear down a
 * session the client currently holds elsewhere (see server.md "Relay").
 */
export type ClientFrame =
  | { t: 'pair'; hostId: string; request: PairingRequest }
  | { t: 'pair-status'; hostId: string; query: PairStatusQuery }
  | { t: 'connect'; hostId: string }
  | { t: 'connect2'; hostId: string; request: ConnectionRequest }
  | { t: 'msg'; data: unknown }
  | E2eClientFrame;

/** Server → client. */
export type ServerToClientFrame =
  | { t: 'pair-result'; approved: boolean; record?: HostAclRecord; error?: string }
  | { t: 'pair-status-result'; hostId: string; paired: boolean }
  | { t: 'challenge'; hostId: string; challenge: string; expiresAt: number }
  | { t: 'decision'; allowed: boolean; failures?: readonly ConnectionFailure[] }
  | { t: 'msg'; data: unknown }
  | { t: 'host-gone' }
  | { t: 'error'; error: string }
  | E2eServerToClientFrame;

/** Server → host. Every frame addresses one Client by its server-assigned `clientId`. */
export type ServerToHostFrame =
  | { t: 'pair'; clientId: string; request: PairingRequest }
  | { t: 'pair-status'; clientId: string; query: PairStatusQuery }
  | { t: 'connect'; clientId: string }
  | { t: 'connect2'; clientId: string; request: ConnectionRequest }
  | { t: 'msg'; clientId: string; data: unknown }
  | { t: 'client-gone'; clientId: string }
  | E2eServerToHostFrame;

/**
 * Host → server. `pair-status-result` carries no hostId — the relay knows which
 * Host the socket belongs to and stamps it on the way out, exactly as it does
 * for `challenge`.
 */
export type HostFrame =
  | { t: 'pair-result'; clientId: string; approved: boolean; record?: HostAclRecord; error?: string }
  | { t: 'pair-status-result'; clientId: string; paired: boolean }
  | { t: 'challenge'; clientId: string; challenge: string; expiresAt: number }
  | { t: 'decision'; clientId: string; allowed: boolean; failures?: readonly ConnectionFailure[] }
  | { t: 'msg'; clientId: string; data: unknown }
  | E2eHostFrame;

// ---------------------------------------------------------------------------
// The `e2e` relay envelope: one end-to-end Noise message per frame, in a
// bounded routing envelope. Additive beside the legacy union above, with no
// production speaker yet (server.md -> Relay).

/** Which ceremony a frame belongs to; a session is scoped to one kind and id. */
export type E2eKind = 'pairing' | 'connection';

/** A Client speaks message 1 (`init`), then transport. */
export type E2eClientStep = 'init' | 'transport';

/** A Host answers message 2 (`response`), then transport. */
export type E2eHostStep = 'response' | 'transport';

/**
 * Every routing id on this envelope — `hostId`, `id`, `clientId` — is this many
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
 * The longest `clientId` a Host will act on. The relay mints these as base64url
 * of 16 random bytes; the headroom exists because the id is a *map key* on a
 * hostile-relay path — bounding every other field while leaving the key free
 * would bound only the part that was already bounded.
 */
export const MAX_CLIENT_ID_LENGTH = 256;

/** Client → server. */
export interface E2eClientFrame {
  t: 'e2e';
  hostId: string;
  kind: E2eKind;
  id: string;
  step: E2eClientStep;
  /** One base64url Noise message. The relay never decodes it. */
  ct: string;
}

/** Server → host: the Client's frame with the server-assigned `clientId`. */
export interface E2eServerToHostFrame extends E2eClientFrame {
  clientId: string;
}

/** Host → server. */
export interface E2eHostFrame {
  t: 'e2e';
  clientId: string;
  kind: E2eKind;
  id: string;
  step: E2eHostStep;
  ct: string;
}

/** Server → client: the Host's frame with `hostId` stamped, as for `challenge`. */
export interface E2eServerToClientFrame extends Omit<E2eHostFrame, 'clientId'> {
  hostId: string;
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
 * The shape guard both a relay and a Host run on a Client-originated `e2e`
 * frame — the both-sides rule `pair-status` already follows (server.md ->
 * Relay). It cannot check the ciphertext, so all it enforces is that the
 * routing values are bounded. Pinned by `server-lib-common/test/wire.test.mjs`
 * and, against real relay-minted ids, `server/test/e2e-relay.test.mjs`.
 */
export function isE2eClientFrame(value: unknown): value is E2eClientFrame {
  if (!value || typeof value !== 'object') return false;
  const frame = value as Record<string, unknown>;
  return (
    frame.t === 'e2e' &&
    // A `hostId` is minted the same way an invitation or connection id is, so
    // one length rule covers every routing id the Client puts on an envelope.
    isE2eId(frame.hostId) &&
    isE2eKind(frame.kind) &&
    isE2eId(frame.id) &&
    (frame.step === 'init' || frame.step === 'transport') &&
    isE2eCiphertext(frame.ct)
  );
}

/**
 * {@link isE2eClientFrame} plus the relay-stamped `clientId` a Host reads. The
 * free `clientId` bound runs first: the ciphertext scan it would otherwise
 * follow costs ~33 µs on a maximal `ct`, and a hostile relay can send those at
 * line rate.
 */
export function isE2eServerToHostFrame(value: unknown): value is E2eServerToHostFrame {
  return (
    isBoundedString((value as { clientId?: unknown } | null)?.clientId, MAX_CLIENT_ID_LENGTH) &&
    isE2eClientFrame(value)
  );
}

/**
 * The shape guard a **Client** runs on what the relay hands it — the mirror of
 * {@link isE2eServerToHostFrame}, and run for the same reason: the Client does
 * not trust the relay to have bounded anything, and every value here is a map
 * key or a base64url decode away from being work.
 */
export function isE2eServerToClientFrame(value: unknown): value is E2eServerToClientFrame {
  if (!value || typeof value !== 'object') return false;
  const frame = value as Record<string, unknown>;
  return (
    frame.t === 'e2e' &&
    isE2eId(frame.hostId) &&
    isE2eKind(frame.kind) &&
    isE2eId(frame.id) &&
    (frame.step === 'response' || frame.step === 'transport') &&
    isE2eCiphertext(frame.ct)
  );
}

/** The shape guard a relay runs on a Host-originated `e2e` frame. */
export function isE2eHostFrame(value: unknown): value is E2eHostFrame {
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
// Remote-api v1, terminal-only (see remote-api.md "v1 scope" and server.md).
// These ride inside `msg` frames once a session is authorized.

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
  hostId: string;
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
  /** Base64url PTY output bytes. */
  bytes: string;
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
 * the Host api, the client adapter, and the test harness all sanitize sizes the
 * same way.
 *
 * Clamped at **both** ends, and the upper bound is the security-relevant half:
 * a local resize is derived from element geometry and cannot be large, but
 * `terminal.resize` carries a peer-supplied number straight to `term.resize`
 * in the webview that owns the pane, and xterm bounds only the minimum before
 * allocating `rows × cols` cells. Unbounded, one frame asking for a million by
 * a million wedges every terminal in that window — reachable by an authorized
 * Client, or by a compromised Server forging `msg` on an established session
 * (`SECURITY.md` -> Remote Control, Trust boundary).
 */
export function clampTerminalDimension(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_TERMINAL_DIMENSION, Math.max(1, Math.floor(value)));
}
