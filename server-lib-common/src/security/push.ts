/**
 * Push subscription binding (spec: docs/specs/alert.md -> Push notifications).
 *
 * A Web Push subscription is a bearer capability: anyone holding the endpoint
 * and its keys can send that phone a notification. The Server therefore has to
 * know *which* Client a subscription belongs to, because the Host addresses a
 * push by `devicePublicKey` — the same Client identity the Host ACL records.
 *
 * The Client proves that binding by signing the subscription with its device
 * key, exactly as it proves identity when connecting. What it emphatically does
 * NOT do is confer access: a push subscription authorizes nothing. It is a
 * delivery address the Host may choose to write to, and the Host's ACL remains
 * the only thing that decides what a Client may reach
 * (docs/specs/remote-security-model.md).
 *
 * This lives beside `deviceKey.ts` rather than inside it because it is a
 * different statement under a different domain — see below.
 */

import { fromBase64Url, lengthPrefixedConcat, toBase64Url, utf8Encode } from './bytes.js';
import { signDevicePayload } from './deviceKey.js';
import { getWebCrypto, type CryptoKeyLike, type WebCryptoLike } from './webcrypto.js';


/**
 * Domain-separation tag for the push-subscription statement. Deliberately NOT
 * `DEVICE_AUTH_DOMAIN`: that domain exists so a device-auth signature can never
 * be replayed as any other kind of statement, and "I subscribe this endpoint"
 * is a different statement from "I am the Client answering this Host challenge".
 *
 * The distinction has teeth here. The Server relays Host-issued challenges to
 * the Client during `connect`, so it sees them in transit; sharing one domain
 * would mean a challenge captured in one protocol could be fed to the other.
 * Bump the version on any payload format change.
 */
export const PUSH_SUBSCRIBE_DOMAIN = 'dormouse/push-subscribe/v1';

/**
 * What a push-subscribe signature attests to: "this device key, paired with
 * this host, subscribes this endpoint, in answer to this challenge".
 *
 * Binding `endpoint` is what stops a captured signature from being reused to
 * register a *different* endpoint under the same identity — without it the
 * signature would authenticate the subscriber but not the subscription.
 */
export interface PushSubscribeContext {
  /** The Host this subscription receives pushes from. */
  readonly hostId: string;
  /** Base64url challenge issued by the Server. */
  readonly challenge: string;
  /** Base64url raw P-256 point — the Client identity claiming the subscription. */
  readonly devicePublicKey: string;
  /** The push service URL the browser handed out. */
  readonly endpoint: string;
}

/** The exact bytes a device key signs for {@link PushSubscribeContext}. */
export function pushSubscribePayload(context: PushSubscribeContext): Uint8Array {
  return lengthPrefixedConcat([
    utf8Encode(PUSH_SUBSCRIBE_DOMAIN),
    utf8Encode(context.hostId),
    fromBase64Url(context.challenge),
    fromBase64Url(context.devicePublicKey),
    utf8Encode(context.endpoint),
  ]);
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

/** Client side: sign a subscription with the device private key. Returns base64url. */
export function signPushSubscribe(
  privateKey: CryptoKeyLike,
  context: PushSubscribeContext,
  crypto: WebCryptoLike = getWebCrypto(),
): Promise<string> {
  return signDevicePayload(privateKey, pushSubscribePayload(context), crypto);
}

// ---------------------------------------------------------------------------
// Payload text

/**
 * Reduce untrusted text to something safe to put in an OS notification.
 *
 * Shared by the Host (which builds the payload from a Pane label) and the
 * Server (which revalidates before handing it to a push service), so the rule
 * has one implementation across both runtimes rather than a strong copy and a
 * weak one. `lib/pocket/public/sw.js` mirrors it a third time at the render
 * sink; that file is copied verbatim into the build and can import nothing.
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
