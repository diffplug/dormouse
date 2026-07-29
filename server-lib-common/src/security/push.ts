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
import { importDevicePublicKey, DEVICE_SIGN_ALGORITHM } from './deviceKey.js';
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

/** Client side: sign a subscription with the device private key. Returns base64url. */
export async function signPushSubscribe(
  privateKey: CryptoKeyLike,
  context: PushSubscribeContext,
  crypto: WebCryptoLike = getWebCrypto(),
): Promise<string> {
  const signature = await crypto.subtle.sign(
    DEVICE_SIGN_ALGORITHM,
    privateKey,
    pushSubscribePayload(context),
  );
  return toBase64Url(new Uint8Array(signature));
}

/**
 * Server side: verify a push-subscribe signature. Returns false (never throws)
 * for malformed keys, malformed signatures, or any mismatch with the context.
 */
export async function verifyPushSubscribeSignature(
  context: PushSubscribeContext,
  signature: string,
  crypto: WebCryptoLike = getWebCrypto(),
): Promise<boolean> {
  try {
    const publicKey = await importDevicePublicKey(context.devicePublicKey, crypto);
    return await crypto.subtle.verify(
      DEVICE_SIGN_ALGORITHM,
      publicKey,
      fromBase64Url(signature),
      pushSubscribePayload(context),
    );
  } catch {
    return false;
  }
}
