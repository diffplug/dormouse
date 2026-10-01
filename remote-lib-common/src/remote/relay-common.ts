/**
 * What the self-host Relay (`relay/`) and the Hosted Relay
 * (`hosted/server/relay-api.ts`) share beyond the wire contract: the bounds
 * both enforce, the WebAuthn registration checks, the passkey label reduction,
 * and the Pocket origin's Content-Security-Policy. One copy, so the two Relays
 * cannot disagree on what a valid registration, label, or bound is
 * (`docs/specs/relay.md`, `docs/specs/hosted.md` -> "Relay").
 */

import { fromBase64Url, toBase64Url, utf8Decode } from '../security/bytes.js';
import { DEFAULT_PAIRING_TTL_MS } from '../security/pairing.js';
import { boundedPushText } from '../security/push.js';
import { getWebCrypto } from '../security/webcrypto.js';

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

/**
 * A registration's label as a Relay stores it: reduced rather than refused, so
 * a long device name still registers, through the same `boundedPushText` the
 * Burrow reduces a pairing label with, so a control or bidi character cannot
 * reorder what an operator reads out of the store either.
 */
export function reducePasskeyLabel(label: unknown): string {
  return boundedPushText(label, { limit: MAX_PASSKEY_LABEL_LENGTH, fallback: '' });
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
