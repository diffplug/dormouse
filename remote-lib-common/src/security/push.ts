/**
 * The two Web Push helpers both runtimes share (spec: docs/specs/alert.md ->
 * Push notifications).
 *
 * A Web Push subscription is a bearer capability: anyone holding the endpoint
 * and its keys can send that phone a notification. What it emphatically does
 * NOT do is confer access — it is a delivery address the Host may choose to
 * write to, and the Host's ACL remains the only thing that decides what a
 * Client may reach (docs/specs/remote-security-model.md). The authorization for
 * a subscription row is possession of the `deliveryId` the Host minted at
 * pairing, so nothing here signs anything.
 */
import { toBase64Url, utf8Encode } from './bytes.js';
import { getWebCrypto, type WebCryptoLike } from './webcrypto.js';

/**
 * A stable digest of a delivery address, for answering one question only: is
 * the endpoint the browser holds now the same one that was registered?
 *
 * A push service may rotate an endpoint on its own, without the VAPID key
 * changing, which leaves every stored row pointing somewhere unreachable while
 * the browser still reports a perfectly valid subscription. Comparing digests
 * catches that; the Client stores this rather than the endpoint so a bearer
 * capability is not copied into `localStorage` to answer a yes/no question.
 *
 * Not a security boundary — it is a change detector, and a device comparing it
 * against its own record already holds the endpoint itself.
 */
export async function pushEndpointFingerprint(
  endpoint: string,
  crypto: WebCryptoLike = getWebCrypto(),
): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', utf8Encode(endpoint));
  return toBase64Url(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// Payload text

/**
 * Reduce untrusted text to something safe to put in an OS notification.
 *
 * Shared by the Host (which builds the payload from a Pane label, before
 * sealing it) and the Pocket service worker (which re-bounds at the render
 * sink), so the rule has one implementation across both runtimes rather than a
 * strong copy and a weak one. The Server is not one of them: it forwards
 * ciphertext (`docs/specs/remote-security-model.md` -> Push sealing).
 *
 * The label is ultimately terminal-supplied — `OSC 0`/`2`/`9` titles reach the
 * Pane label (`docs/specs/alert.md` -> Text And Security) — so beyond bounding
 * the length this strips control characters and the Unicode bidi and
 * zero-width format characters, which can visually reorder or hide text on a
 * lock screen.
 *
 * Note this deliberately keeps angle brackets. Stripping those is a
 * speech-engine rule (`toSpokenText`), where WebKit wedges on them; a
 * notification renders plain text and a title like `<idle>` should survive.
 */
export function boundedPushText(
  value: unknown,
  { limit, fallback }: { limit: number; fallback: string },
): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value
    // C0, DEL, and C1 control characters.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    // The Arabic letter mark, zero-width and joiner characters, bidi
    // embedding/override marks, bidi isolates, and the BOM. Dropped rather
    // than spaced: they carry no width, so replacing them would invent gaps
    // in an otherwise fine title.
    .replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Capped in code points, not UTF-16 units: a `.slice` landing mid-surrogate
  // would ship a lone half that renders as U+FFFD on the phone.
  return Array.from(cleaned).slice(0, limit).join('').trim() || fallback;
}
