/**
 * The Web Push helpers every runtime shares (spec: docs/specs/alert.md ->
 * Push notifications).
 *
 * A Web Push subscription is a bearer capability: anyone holding the endpoint
 * and its keys can send that phone a notification. What it emphatically does
 * NOT do is confer access — it is a delivery address the Burrow may choose to
 * write to, and the Burrow's ACL remains the only thing that decides what a
 * Client may reach (docs/specs/remote-security-model.md). The authorization for
 * a subscription row is possession of the `deliveryId` the Burrow minted at
 * pairing, which carries a tag its Relay can check.
 */
import {
  constantTimeEqual,
  fromBase64Url,
  isExactBase64Url,
  lengthPrefixedConcat,
  toBase64Url,
  utf8Encode,
} from './bytes.js';
import { DELIVERY_ID_BYTE_LENGTH, DELIVERY_ID_LENGTH } from './acl.js';
import { getWebCrypto, type WebCryptoLike } from './webcrypto.js';

// ---------------------------------------------------------------------------
// Delivery ids

/** The random half of a delivery id; the rest is its tag. */
const DELIVERY_ID_NONCE_LENGTH = 16;
const DELIVERY_ID_TAG_DOMAIN = utf8Encode('dormouse/push-delivery/v1');

/**
 * The key a Burrow tags its delivery ids under and its Relay checks them with:
 * SHA-256 of the `burrowToken`, the one secret the two share. The Hosted Relay
 * stores exactly this digest (hex) as the token's hash, so it checks an id
 * without holding the token.
 */
export async function pushDeliveryKey(
  burrowToken: string,
  crypto: WebCryptoLike = getWebCrypto(),
): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', utf8Encode(burrowToken)));
}

async function deliveryIdTag(
  deliveryKey: Uint8Array,
  burrowId: string,
  nonce: Uint8Array,
  crypto: WebCryptoLike,
): Promise<Uint8Array> {
  const algorithm = { name: 'HMAC', hash: 'SHA-256' };
  const key = await crypto.subtle.importKey('raw', deliveryKey, algorithm, false, ['sign']);
  const mac = await crypto.subtle.sign(
    algorithm,
    key,
    lengthPrefixedConcat([DELIVERY_ID_TAG_DOMAIN, utf8Encode(burrowId), nonce]),
  );
  return new Uint8Array(mac).slice(0, DELIVERY_ID_BYTE_LENGTH - DELIVERY_ID_NONCE_LENGTH);
}

/**
 * A fresh delivery id for one paired Client of `burrowId`: 16 random bytes,
 * then the first 16 bytes of an HMAC-SHA256 over them under
 * {@link pushDeliveryKey}. A Relay registers a subscription only for an id that
 * verifies ({@link deliveryIdMintedBy}), so a session that is not a paired
 * phone cannot register one (`docs/specs/relay.md` -> Web Push).
 */
export async function mintPushDeliveryId(
  deliveryKey: Uint8Array,
  burrowId: string,
  crypto: WebCryptoLike = getWebCrypto(),
): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(DELIVERY_ID_NONCE_LENGTH));
  const id = new Uint8Array(DELIVERY_ID_BYTE_LENGTH);
  id.set(nonce);
  id.set(await deliveryIdTag(deliveryKey, burrowId, nonce, crypto), DELIVERY_ID_NONCE_LENGTH);
  return toBase64Url(id);
}

/**
 * Whether `burrowId`'s Burrow minted `deliveryId` ({@link mintPushDeliveryId}).
 * Async for the HMAC, so never named `is…`: an un-awaited call would read as
 * always true.
 */
export async function deliveryIdMintedBy(
  deliveryKey: Uint8Array,
  burrowId: string,
  deliveryId: unknown,
  crypto: WebCryptoLike = getWebCrypto(),
): Promise<boolean> {
  if (!isExactBase64Url(deliveryId, DELIVERY_ID_LENGTH)) return false;
  const id = fromBase64Url(deliveryId);
  const nonce = id.slice(0, DELIVERY_ID_NONCE_LENGTH);
  const tag = await deliveryIdTag(deliveryKey, burrowId, nonce, crypto);
  return constantTimeEqual(id.slice(DELIVERY_ID_NONCE_LENGTH), tag);
}

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
 * Shared by the Burrow (which builds the payload from a Pane label, before
 * sealing it) and the Pocket service worker (which re-bounds at the render
 * sink), so the rule has one implementation across both runtimes rather than a
 * strong copy and a weak one. The Relay is not one of them: it forwards
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
