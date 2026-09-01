/**
 * The wire contract for the selfhost POC (docs/specs/server.md): HTTP routes
 * and payloads, relay frames, and the terminal-only remote-api v1 messages.
 * Shared by `server`, the Host module in `lib`, and the Pocket UI so the
 * three sides cannot drift — the same pattern as HELLO_ROUTE.
 */

import type { HostAclRecord } from '../security/acl.js';
import type { ConnectionFailure, ConnectionRequest } from '../security/connection.js';
import type { PairStatusQuery, PairingRequest } from '../security/pairing.js';
import type { PasskeyAssertion } from '../security/passkey.js';

// ---------------------------------------------------------------------------
// HTTP API (see server.md "HTTP API")

export const API_ROUTES = {
  setupBegin: '/api/setup/begin',
  setupFinish: '/api/setup/finish',
  signinBegin: '/api/signin/begin',
  signinFinish: '/api/signin/finish',
  reauthBegin: '/api/reauth/begin',
  reauthFinish: '/api/reauth/finish',
  hostEnroll: '/api/host/enroll',
  hostSetupToken: '/api/host/setup-token',
  hosts: '/api/hosts',
  pushConfig: '/api/push/config',
  pushChallenge: '/api/push/challenge',
  pushSubscribe: '/api/push/subscribe',
  pushSubscriptions: '/api/push/subscriptions',
  pushDevices: '/api/push/devices',
  pushSend: '/api/push/send',
} as const;

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
 * Re-assert presence on an existing session (session-token auth; begin reuses
 * the {@link SigninBeginResponse} shape). Used when pairing reports
 * `PAIRING_STALE_PRESENCE_ERROR` (pairing.ts): one WebAuthn prompt refreshes
 * the session's presence stamp without re-minting the token or the relay
 * socket.
 */
export interface ReauthFinishRequest {
  assertion: PasskeyAssertion;
}
export interface ReauthFinishResponse {
  /** Epoch ms the session's presence stamp was refreshed to. */
  presenceVerifiedAt: number;
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
 * Host-token auth. The single-use setup credential an enrolled Host mints to
 * render as a QR: the token only, since the Host composes the QR's URL itself
 * from the origin it enrolled against, and a URL minted server-side would be
 * one more place the deployment's own address is decided. Scanning it replaces
 * typing the origin and the setup password; a short TTL plus single use bound
 * the shoulder-surf window, and the Server tells the minting Host when the
 * token is spent (`ServerToHostFrame` `setup-token-redeemed`).
 *
 * The Host adds a second secret of its own to that URL — the setup nonce behind
 * `PairingRequest.setupProof` — which the Server never sees
 * (`security/setup-proof.ts`).
 */
export interface SetupTokenResponse {
  token: string;
  /**
   * Opaque handle naming *this* mint, so a Host displaying several codes can
   * tell which one a `setup-token-redeemed` frame is about. Deliberately not
   * the token: a correlator that named the credential would put it on a wire
   * that carries no credentials, and only the minter needs to recognize it.
   */
  mintId: string;
  /** Epoch ms after which the token no longer redeems. */
  expiresAt: number;
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

/** Base64url, bounded, non-empty — the shape of every handle on this wire. */
function isSetupTokenHandle(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= SETUP_TOKEN_MAX_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
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
    isSetupTokenHandle(candidate.mintId) &&
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
// Two audiences with different credentials: the Pocket Client registers its own
// subscription with a session token plus a device signature, and the Host reads
// and sends with its `hostToken`. Subscriptions are keyed on the PAIR
// (hostId, devicePublicKey), so a Client subscribes once per Host it is paired
// with and a Host can only ever see or reach its own subscribers.

/** Public VAPID key, needed by the browser before it can subscribe. */
export interface PushConfigResponse {
  /** Base64url VAPID application server key, or null when push is unconfigured. */
  applicationServerKey: string | null;
}

export interface PushChallengeResponse {
  /** Base64url challenge to sign with the device key. */
  challenge: string;
  expiresAt: number;
}

/** The browser's `PushSubscription`, narrowed to what delivery needs. */
export interface PushSubscriptionPayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushSubscribeRequest {
  hostId: string;
  /** Base64url raw P-256 point — the Client identity in the Host's ACL. */
  devicePublicKey: string;
  challenge: string;
  /** Base64url device signature over `pushSubscribePayload`. */
  signature: string;
  subscription: PushSubscriptionPayload;
}
export interface PushSubscribeResponse {
  subscribedAt: number;
  /**
   * Every Host this device is registered with after the mutation — the state,
   * not the delta. One service-worker scope has one subscription, so a changed
   * delivery address drops the device's other Host rows in the same mutation
   * and this is what survives it.
   *
   * Reporting the result rather than the event is what makes a lost response
   * self-healing: the idempotent retry cannot re-announce a deletion it already
   * performed, but it can always answer what is there now, so the Client needs
   * no memory of what it did.
   *
   * Safe to scope to the device even though `PushSubscriptionsResponse`
   * deliberately is not: this request carries a device signature, so the caller
   * has proven it owns the identity being reported on.
   */
  hostIds: string[];
}

/**
 * Session auth. The account's push registrations, so a Client that reloaded can
 * tell which Hosts it is already registered with instead of re-offering the
 * action for all of them.
 *
 * Deliberately **not** parameterized by `devicePublicKey`: an endpoint that
 * answered "which Hosts is device X registered with" would be an enumeration
 * primitive over an input the caller need not own. This returns what the
 * account owns and the Client filters to its own device — the same scoping
 * `GET /api/hosts` already uses, and correct per-tenant if the SaaS mode in
 * `## Future` lands.
 *
 * Identities only. The endpoint and its keys are a bearer capability to notify
 * that phone and never leave the Server.
 */
export interface PushSubscriptionsResponse {
  subscriptions: Array<{ hostId: string; devicePublicKey: string; subscribedAt: number }>;
}

/**
 * Host-token auth. Returns identities only — the Host holds the ACL and is the
 * only side that can turn a `devicePublicKey` into a human label, so the Server
 * never learns one (docs/specs/remote-security-model.md).
 */
export interface PushDevicesResponse {
  devices: Array<{ devicePublicKey: string; subscribedAt: number }>;
}

/**
 * Host-token auth. `devicePublicKeys` is required and non-empty: the Host holds
 * the ACL and is the only party that may decide who a push reaches, so the
 * Server never selects recipients itself.
 */
export interface PushSendRequest {
  devicePublicKeys: string[];
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
  /** Named devices with no subscription for this Host. */
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
  | { t: 'msg'; data: unknown };

/** Server → client. */
export type ServerToClientFrame =
  | { t: 'pair-result'; approved: boolean; record?: HostAclRecord; error?: string }
  | { t: 'pair-status-result'; hostId: string; paired: boolean }
  | { t: 'challenge'; hostId: string; challenge: string; expiresAt: number }
  | { t: 'decision'; allowed: boolean; failures?: readonly ConnectionFailure[] }
  | { t: 'msg'; data: unknown }
  | { t: 'host-gone' }
  | { t: 'error'; error: string };

/**
 * Server → host. Every frame but `setup-token-redeemed` addresses one Client by
 * its server-assigned `clientId`; that one carries none by design, because it
 * is about the Host itself — a setup token this Host minted
 * ({@link SetupTokenResponse}) was just spent, so the QR showing it is stale
 * and each redemption is visible to the person who displayed it. It names the
 * mint rather than the token, so a Host that displayed several codes can retire
 * the right one without the credential crossing back.
 */
export type ServerToHostFrame =
  | { t: 'pair'; clientId: string; request: PairingRequest }
  | { t: 'pair-status'; clientId: string; query: PairStatusQuery }
  | { t: 'connect'; clientId: string }
  | { t: 'connect2'; clientId: string; request: ConnectionRequest }
  | { t: 'msg'; clientId: string; data: unknown }
  | { t: 'client-gone'; clientId: string }
  | { t: 'setup-token-redeemed'; mintId: string };

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
  | { t: 'msg'; clientId: string; data: unknown };

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
