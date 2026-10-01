/**
 * What the self-host Relay (`relay/`) and the Hosted Relay
 * (`hosted/server/relay-api.ts`) share beyond the wire contract: the bounds
 * both enforce, the registration checks and the sign-in pipeline in their
 * order, the passkey label reduction, and the Pocket origin's
 * Content-Security-Policy. One copy, so the two Relays cannot
 * disagree on what a valid registration, assertion, label, or bound is
 * (`docs/specs/relay.md`, `docs/specs/hosted.md` -> "Relay").
 */

import { DELIVERY_ID_LENGTH } from '../security/acl.js';
import {
  fromBase64Url,
  isBoundedBase64Url,
  isExactBase64Url,
  toBase64Url,
  utf8Decode,
} from '../security/bytes.js';
import { CEREMONY_FIELD_LIMIT } from '../security/e2e-ceremony.js';
import { DEFAULT_PAIRING_TTL_MS } from '../security/pairing.js';
import {
  verifyPasskeyAssertion,
  type ConnectionPolicy,
  type PasskeyAssertion,
} from '../security/passkey.js';
import { boundedPushText } from '../security/push.js';
import { MAX_SEALED_PUSH_LENGTH, isSealedPushV1 } from '../security/push-seal.js';
import { getWebCrypto } from '../security/webcrypto.js';
import { importableWebPushKeys } from './web-push.js';
import {
  E2E_ID_LENGTH,
  MAX_CLIENT_ID_LENGTH,
  MAX_E2E_CIPHERTEXT_LENGTH,
  RELAY_PING_INTERVAL_MS,
  CLIENT_DATA_TYPE_ERROR,
  MALFORMED_ASSERTION_ERROR,
  MALFORMED_CLIENT_DATA_ERROR,
  MALFORMED_CREDENTIAL_ID_ERROR,
  ORIGIN_MISMATCH_ERROR,
  UNIMPORTABLE_KEY_ERROR,
  UNKNOWN_CHALLENGE_ERROR,
  UNKNOWN_CREDENTIAL_ERROR,
  assertionRejectedError,
  MAX_PUSH_QUERY_DELIVERY_IDS,
  type PushSubscriptionPayload,
  type SealedPushRecipient,
} from './wire.js';

/** The bearer shape lives in the wire contract; re-exported for the Relays. */
export { RELAY_BEARER_BYTE_LENGTH, RELAY_BEARER_LENGTH, isRelayBearer } from './wire.js';

/**
 * The largest relay frame either Relay will read, from either socket kind.
 * Derived from the wire bounds the frame guards enforce — a maximal `ct` plus
 * the envelope around it — so the raw text is bounded before any parse: the
 * self-host Relay hands it to `ws` as `maxPayload` (which otherwise buffers up
 * to 100 MiB), the Hosted Relay measures each message against it.
 * `MAX_CLIENT_ID_LENGTH` is in here because a Burrow frame carries one.
 */
export const MAX_RELAY_FRAME_BYTES =
  MAX_E2E_CIPHERTEXT_LENGTH + MAX_CLIENT_ID_LENGTH + 2 * E2E_ID_LENGTH + 1024;

/** A frame over {@link MAX_RELAY_FRAME_BYTES} closes its socket with this. */
export const WS_CLOSE_FRAME_TOO_LARGE = 1009;

/**
 * How many Client sockets one Relay holds at once: the self-host process, or
 * one account's Durable Object on Hosted. One account's phones are a handful,
 * so this is far above real use; without it a token-holder opens sockets until
 * the Relay runs out.
 */
export const MAX_RELAY_CLIENT_SOCKETS = 64;

/** Refused because the Relay is already holding {@link MAX_RELAY_CLIENT_SOCKETS}. */
export const WS_CLOSE_TRY_AGAIN_LATER = 1013;

/**
 * The session behind this socket is gone. The same pair the `/ws/client`
 * upgrade answers with, so a socket closed after the fact is indistinguishable
 * from one refused at the door and Pocket needs no second recovery.
 */
export const WS_CLOSE_UNAUTHORIZED = 1008;
export const WS_CLOSE_UNAUTHORIZED_REASON = 'unauthorized';

/** A socket closed for silence, not for anything it did. */
export const WS_CLOSE_IDLE = 1001;
export const WS_CLOSE_IDLE_REASON = 'no response to heartbeat';

/**
 * How long either Relay lets a relay socket go unheard from before it counts
 * as gone: three ping intervals. A live peer answers the first ping, so
 * reaching this means the connection is half-open, not idle; generous against
 * a phone whose radio has dozed, which reconnects anyway.
 */
export const RELAY_IDLE_TIMEOUT_MS = 3 * RELAY_PING_INTERVAL_MS;

/** Sessions live 12 hours (relay.md: "hours-scale TTL"). */
export const RELAY_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * How long a presence nonce stays redeemable. The same two minutes a Burrow
 * challenge lasts: both bound one ceremony's WebAuthn prompt, and a longer
 * window would only widen the gap between "the user touched the sensor" and
 * "the Burrow believed it".
 */
export const REAUTH_NONCE_TTL_MS = 2 * 60 * 1000;

/**
 * How many unredeemed presence nonces ONE SESSION will hold.
 *
 * `POST /api/reauth/begin` needs only a session token, so without a cap one
 * signed-in caller can grow the store by asking. Far above any real use: a
 * phone holds one nonce at a time, per ceremony.
 *
 * **Per session, never global.** A nonce is minted *before* its WebAuthn
 * prompt, so it waits out seconds of human latency; a global cap made a flood
 * from any other session evict a legitimate phone's nonce inside that window,
 * failing every pairing and connection ceremony for as long as the flood ran.
 * A caller can only ever evict its own.
 */
export const MAX_PENDING_REAUTH_NONCES_PER_SESSION = 8;

/**
 * How long a minted setup token stays redeemable. It *is*
 * `DEFAULT_PAIRING_TTL_MS` because the two are one window from the user's
 * side: the nonce the token leaves behind rides into the pairing request, so
 * it must outlive the passkey ceremony between scanning the QR and pairing.
 */
export const SETUP_TOKEN_TTL_MS = DEFAULT_PAIRING_TTL_MS;

/**
 * How many Burrows one account may have enrolled, on either Relay.
 *
 * Enrollment is credential-gated, so this is not a flood defense. On the
 * self-host Relay it bounds a file that is otherwise append-only and is
 * re-read, re-parsed and compared row by row on every burrow-gated request and
 * every `/ws/burrow` upgrade; on Hosted it bounds what one account's approvals
 * can grow. Far above the machines a person owns; revocation (self-host) or
 * removal (Hosted) is what makes room.
 */
export const MAX_ENROLLED_BURROWS = 32;

/**
 * Longest passkey label a Relay will store, in code points. A device name, so
 * this is generous — and it is a bound at all because the row is durable and
 * is re-read on every sign-in and every re-auth.
 */
export const MAX_PASSKEY_LABEL_LENGTH = 64;

/**
 * Longest request body any Relay route but the self-host `/api/push/send`
 * will read.
 *
 * Unauthenticated routes — `/api/burrow/enroll`, `/api/setup/*`,
 * `/api/signin/finish` — read their body BEFORE the credential gate, so
 * without this any caller could make the Relay buffer gigabytes with no auth.
 * Every body a Relay actually takes is a handful of base64url fields, so 64 KiB
 * is orders of magnitude above real use.
 */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Web Push bounds (`docs/specs/relay.md` -> "Web Push" and "State files").

/**
 * How many push subscriptions one Burrow, and one account, may hold.
 *
 * `POST /api/push/subscribe` needs a session token and a `deliveryId` the
 * caller picks for itself — the Relay cannot check one against a Burrow's ACL,
 * by design — so without a cap one signed-in caller appends a durable row per
 * request, and every push route thereafter reads it. Every sibling transient
 * store is capped (`MAX_PENDING_REAUTH_NONCES_PER_SESSION`,
 * `MAX_TOKENS_PER_BURROW`); this is the durable one, so it matters more.
 *
 * Far above any real use: the per-Burrow cap is phones paired with one laptop,
 * the per-account cap that across every laptop an account enrolled. A
 * self-host Relay has one account, so its per-account cap is its total.
 */
export const MAX_PUSH_SUBSCRIPTIONS_PER_BURROW = 32;
export const MAX_PUSH_SUBSCRIPTIONS_PER_ACCOUNT = 256;

/**
 * Longest push endpoint a Relay will store. A real one is a provider URL a
 * couple of hundred characters long (FCM, APNs and Mozilla autopush all sit
 * well under this), so the cap is several times the headroom any of them needs
 * — and it is what keeps a stored row a known size.
 */
export const MAX_PUSH_ENDPOINT_LENGTH = 1024;

/**
 * Longest `keys.p256dh` / `keys.auth` a Relay will store. RFC 8291 fixes
 * both: `p256dh` is an uncompressed P-256 point (65 bytes) and `auth` is the
 * 16-byte auth secret, so the caps are their base64 encodings *with* padding —
 * browsers emit unpadded base64url, and a padded serialization must not be the
 * thing that breaks a real subscription.
 */
export const MAX_PUSH_KEY_P256DH_LENGTH = 88;
export const MAX_PUSH_KEY_AUTH_LENGTH = 24;

/**
 * The push service's TTL on every delivery. Short on purpose: an alarm that
 * arrives an hour late is noise, not information, so a push service holding
 * one for an offline phone should drop it rather than deliver it stale.
 */
export const PUSH_TTL_SECONDS = 300;

/**
 * The one route whose legitimate body outgrows {@link MAX_REQUEST_BODY_BYTES}:
 * `/api/push/send`, a fan-out of `MAX_PUSH_QUERY_DELIVERY_IDS` sealed
 * envelopes, each already bounded by `MAX_SEALED_PUSH_LENGTH`. Derived from
 * those two rather than written out, so tightening either tightens this with
 * it; the per-recipient allowance covers the delivery id, the salt, and the
 * JSON around them.
 */
const PUSH_SEND_RECIPIENT_OVERHEAD_BYTES = 256;
export const MAX_PUSH_SEND_BODY_BYTES =
  MAX_PUSH_QUERY_DELIVERY_IDS *
    (DELIVERY_ID_LENGTH + MAX_SEALED_PUSH_LENGTH + PUSH_SEND_RECIPIENT_OVERHEAD_BYTES) +
  PUSH_SEND_RECIPIENT_OVERHEAD_BYTES;

/**
 * Base64url of exactly {@link DELIVERY_ID_LENGTH} characters — the Burrow mints
 * 32 random bytes, so anything else is not an id any Burrow ever issued and must
 * be refused before it becomes a row key.
 */
export function isPushDeliveryId(value: unknown): value is string {
  return isExactBase64Url(value, DELIVERY_ID_LENGTH);
}

/**
 * True if `value` is a `PushSubscriptionPayload` whose keys a sender can
 * encrypt to: each within its bound, `p256dh` decoding to an uncompressed
 * point on P-256 and `auth` to 16 bytes, padded or not
 * (`importableWebPushKeys`), so a row no push could ever reach is refused at
 * registration. **Every stored field is bounded**: these three are the whole
 * row. Async for the curve check, so never named `is…`: an un-awaited call
 * would read as always true.
 */
export async function admissiblePushSubscription(value: unknown): Promise<boolean> {
  if (!value || typeof value !== 'object') return false;
  const v = value as PushSubscriptionPayload;
  return (
    isBoundedNonEmptyString(v.endpoint, MAX_PUSH_ENDPOINT_LENGTH) &&
    !!v.keys &&
    typeof v.keys === 'object' &&
    isBoundedNonEmptyString(v.keys.p256dh, MAX_PUSH_KEY_P256DH_LENGTH) &&
    isBoundedNonEmptyString(v.keys.auth, MAX_PUSH_KEY_AUTH_LENGTH) &&
    (await importableWebPushKeys(v.keys))
  );
}

/**
 * One `{ deliveryId, sealed }` pair on a send. Shape and bounds are the whole
 * of what a Relay can check — it holds no key — and the envelope's bound is
 * its only defense against forwarding megabytes at a phone.
 */
export function isSealedPushRecipient(value: unknown): value is SealedPushRecipient {
  if (!value || typeof value !== 'object') return false;
  const v = value as SealedPushRecipient;
  return isPushDeliveryId(v.deliveryId) && isSealedPushV1(v.sealed);
}

function isBoundedNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/**
 * A registration's label as a Relay stores it: reduced rather than refused, so
 * a long device name still registers, through the same `boundedPushText` the
 * Burrow reduces a pairing label with, so a control or bidi character cannot
 * reorder what an operator reads out of the store either.
 */
export function reducePasskeyLabel(label: unknown): string {
  return boundedPushText(label, { limit: MAX_PASSKEY_LABEL_LENGTH, fallback: '' });
}

/** The token of an `Authorization: Bearer <token>` header, or `null`; the caller checks its shape. */
export function parseBearer(header: string | null | undefined): string | null {
  return /^Bearer (\S+)$/.exec(header ?? '')?.[1] ?? null;
}

/** A request's JSON body, or `null` when it is absent or not JSON. */
export async function readJson<T = unknown>(c: { req: { json(): Promise<unknown> } }): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

/** A route's refusal: the status and `error` both Relays answer it with. */
export interface RelayRefusal {
  readonly ok: false;
  readonly status: 400 | 401 | 404;
  readonly error: string;
}

const refuse = (status: RelayRefusal['status'], error: string): RelayRefusal => ({
  ok: false,
  status,
  error,
});

/** A registration that passed {@link checkRegistration}, its label reduced. */
export interface CheckedRegistration {
  readonly ok: true;
  readonly credentialId: string;
  readonly publicKey: string;
  readonly label: string;
}

/**
 * `POST /api/setup/finish`'s checks after its setup-token gate, in order:
 * `clientDataJSON` decodes, its type is `webauthn.create`, its challenge
 * redeems through `redeem` (single-use, so it is spent here), its origin is
 * `origin`, the public key imports as ECDSA P-256, and the credential id is
 * bounded base64url. Each refusal is a 400. Attestation is not parsed: the
 * browser hands over the SPKI key (`attestation: 'none'`). Whether the
 * credential is new is the caller's store to answer.
 */
export async function checkRegistration(
  body: unknown,
  { origin, redeem }: { origin: string; redeem(challenge: string): boolean | Promise<boolean> },
): Promise<CheckedRegistration | RelayRefusal> {
  const fields = (body ?? {}) as {
    clientDataJSON?: unknown;
    publicKey?: unknown;
    credentialId?: unknown;
    label?: unknown;
  };
  const clientData = decodeClientData(fields.clientDataJSON);
  if (!clientData) return refuse(400, MALFORMED_CLIENT_DATA_ERROR);
  if (clientData.type !== 'webauthn.create') return refuse(400, CLIENT_DATA_TYPE_ERROR);
  const challenge = normalizeChallenge(clientData.challenge);
  if (challenge === null || !(await redeem(challenge))) return refuse(400, UNKNOWN_CHALLENGE_ERROR);
  if (clientData.origin !== origin) return refuse(400, ORIGIN_MISMATCH_ERROR);
  // Never a key no later assertion could be verified against.
  if (!(await importableSpkiP256(fields.publicKey))) return refuse(400, UNIMPORTABLE_KEY_ERROR);
  const { publicKey } = fields as { publicKey: string };
  // Stored verbatim and handed back to every later `setup/begin`, which the
  // Client base64url-decodes: one malformed id would wedge registration.
  if (!isBoundedBase64Url(fields.credentialId, CEREMONY_FIELD_LIMIT)) {
    return refuse(400, MALFORMED_CREDENTIAL_ID_ERROR);
  }
  return {
    ok: true,
    credentialId: fields.credentialId,
    publicKey,
    label: reducePasskeyLabel(fields.label),
  };
}

/** The canonical challenge an assertion's own `clientDataJSON` names, or `null`. */
export function assertionChallenge(assertion: { readonly clientDataJSON?: unknown }): string | null {
  const clientData = decodeClientData(assertion.clientDataJSON);
  return clientData && typeof clientData.challenge === 'string'
    ? normalizeChallenge(clientData.challenge)
    : null;
}

/**
 * `POST /api/signin/finish`'s verifier, in order: the assertion's shape (400),
 * its credential's stored passkey through `findPasskey` (404), the challenge
 * its `clientDataJSON` names (400), that challenge spent through
 * `consumeChallenge` BEFORE verifying, so a captured assertion never replays
 * even if verification succeeds (400), and `verifyPasskeyAssertion` against
 * the stored key under `policy`, the same UV policy re-auth enforces (401).
 */
export async function verifySigninAssertion<Passkey extends { readonly publicKey: string }>(
  assertion: unknown,
  {
    findPasskey,
    consumeChallenge,
    policy,
  }: {
    findPasskey(credentialId: string): Promise<Passkey | null | undefined>;
    consumeChallenge(challenge: string): boolean | Promise<boolean>;
    policy: ConnectionPolicy;
  },
): Promise<{ readonly ok: true; readonly passkey: Passkey } | RelayRefusal> {
  const candidate = assertion as Partial<PasskeyAssertion> | null | undefined;
  if (!candidate || typeof candidate !== 'object' || typeof candidate.credentialId !== 'string') {
    return refuse(400, MALFORMED_ASSERTION_ERROR);
  }
  const passkey = await findPasskey(candidate.credentialId);
  if (!passkey) return refuse(404, UNKNOWN_CREDENTIAL_ERROR);
  const challenge = assertionChallenge(candidate);
  if (challenge === null) return refuse(400, MALFORMED_CLIENT_DATA_ERROR);
  if (!(await consumeChallenge(challenge))) return refuse(400, UNKNOWN_CHALLENGE_ERROR);
  const result = await verifyPasskeyAssertion(candidate as PasskeyAssertion, passkey.publicKey, {
    ...policy,
    challenge,
  });
  if (!result.ok) return refuse(401, assertionRejectedError(result.reason));
  return { ok: true, passkey };
}

/** Decode base64url clientDataJSON to its parsed object, or `null` if malformed. */
export function decodeClientData(
  clientDataJSON: unknown,
): { type?: unknown; challenge?: unknown; origin?: unknown } | null {
  if (typeof clientDataJSON !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(utf8Decode(fromBase64Url(clientDataJSON)));
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Canonicalize browser-serialized base64url challenges before single-use lookup. */
export function normalizeChallenge(challenge: unknown): string | null {
  if (typeof challenge !== 'string') return null;
  try {
    return toBase64Url(fromBase64Url(challenge));
  } catch {
    return null;
  }
}

/** True if `publicKey` (base64url SPKI) imports as an ECDSA P-256 verify key. */
export async function importableSpkiP256(publicKey: unknown): Promise<boolean> {
  if (typeof publicKey !== 'string') return false;
  try {
    await getWebCrypto().subtle.importKey(
      'spki',
      fromBase64Url(publicKey),
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['verify'],
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * The Pocket origin's Content-Security-Policy
 * (`docs/specs/pocket-app.md` -> Deployment), for an `origin` the caller has
 * already held to a bare `http(s)` origin — which is what makes the scheme
 * swap below exact rather than a guess.
 *
 * Every source is the app's own origin. The loosenings are load-bearing and no
 * wider than they must be:
 *
 * * `style-src 'unsafe-inline'` — the shell carries an inline `<style>` for
 *   viewport plumbing that has to apply before first paint, and React writes
 *   `style` attributes. A hash covers the first but not the second.
 * * `connect-src` names the WebSocket origin explicitly rather than resting on
 *   `'self'`, whose ws/wss coverage browsers have disagreed about. It is the
 *   origin with the scheme swapped, so it can only ever be this deployment's
 *   own relay.
 * * `img-src` also admits `data:` and `blob:`, `media-src` `blob:` — images and
 *   media the page builds in memory rather than fetches.
 *
 * `script-src` needs no *script* exception: the build emits no inline script
 * and loads nothing off-origin, which `assertPocketShell` pins against the
 * built output. Its one addition is `'wasm-unsafe-eval'`, which
 * `@xterm/addon-image` needs to compile the SIXEL decoder it vendors. It
 * permits WebAssembly compilation and nothing else.
 */
export function pocketContentSecurityPolicy(origin: string): string {
  const wsOrigin = `ws${origin.slice('http'.length)}`;
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "media-src 'self' blob:",
    `connect-src 'self' ${wsOrigin}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}
