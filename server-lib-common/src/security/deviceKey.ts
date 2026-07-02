/**
 * Device keys: long-lived Client identity (spec: docs/specs/remote-security-model.md).
 *
 * Each Client generates a non-extractable ECDSA P-256 keypair in the browser;
 * the base64url raw public key is the Client's identifier everywhere in the
 * model (Host ACL records, pairing requests, connection requests). The private
 * key signs Host challenges to prove the connecting Client is the paired one —
 * a capability a synced or newly-added passkey does not confer.
 */

import { fromBase64Url, lengthPrefixedConcat, toBase64Url, utf8Encode } from './bytes.js';
import { getWebCrypto, type CryptoKeyLike, type WebCryptoLike } from './webcrypto.js';

export const DEVICE_KEY_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
export const DEVICE_SIGN_ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' } as const;

/**
 * Domain-separation tag mixed into every device-key signature so a signature
 * produced for device auth can never be replayed as any other kind of
 * statement (and vice versa). Bump the version on any payload format change.
 */
export const DEVICE_AUTH_DOMAIN = 'dormouse/device-auth/v1';

export interface DeviceKeyPair {
  readonly publicKey: CryptoKeyLike;
  /** Non-extractable: can sign, but the key material never leaves the runtime. */
  readonly privateKey: CryptoKeyLike;
  /** Base64url raw P-256 point — the Client's identity string. */
  readonly devicePublicKey: string;
}

/**
 * Generate a Client device keypair. The private key is non-extractable; the
 * browser side is expected to persist the `CryptoKey` objects in IndexedDB
 * (with `navigator.storage.persist()`) rather than exporting anything.
 */
export async function generateDeviceKeyPair(
  crypto: WebCryptoLike = getWebCrypto(),
): Promise<DeviceKeyPair> {
  const pair = await crypto.subtle.generateKey(DEVICE_KEY_ALGORITHM, false, ['sign', 'verify']);
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
  return {
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    devicePublicKey: toBase64Url(new Uint8Array(raw)),
  };
}

/** Import a Client identity string back into a verification key. Throws if malformed. */
export async function importDevicePublicKey(
  devicePublicKey: string,
  crypto: WebCryptoLike = getWebCrypto(),
): Promise<CryptoKeyLike> {
  return crypto.subtle.importKey('raw', fromBase64Url(devicePublicKey), DEVICE_KEY_ALGORITHM, true, [
    'verify',
  ]);
}

/**
 * What a device-key signature attests to: "this device key answers this
 * challenge from this host". Binding the host id scopes the signature to one
 * Host; binding the device public key pins which identity the signer claims.
 */
export interface DeviceAuthContext {
  readonly hostId: string;
  /** Base64url challenge issued by the Host. */
  readonly challenge: string;
  /** Base64url device public key the Client claims as its identity. */
  readonly devicePublicKey: string;
}

/** The exact bytes a device key signs for {@link DeviceAuthContext}. */
export function deviceAuthPayload(context: DeviceAuthContext): Uint8Array {
  return lengthPrefixedConcat([
    utf8Encode(DEVICE_AUTH_DOMAIN),
    utf8Encode(context.hostId),
    fromBase64Url(context.challenge),
    fromBase64Url(context.devicePublicKey),
  ]);
}

/** Client side: sign a Host challenge with the device private key. Returns base64url. */
export async function signDeviceChallenge(
  privateKey: CryptoKeyLike,
  context: DeviceAuthContext,
  crypto: WebCryptoLike = getWebCrypto(),
): Promise<string> {
  const signature = await crypto.subtle.sign(
    DEVICE_SIGN_ALGORITHM,
    privateKey,
    deviceAuthPayload(context),
  );
  return toBase64Url(new Uint8Array(signature));
}

/**
 * Host side: verify a device-key signature. Returns false (never throws) for
 * malformed keys, malformed signatures, or any mismatch with the context.
 */
export async function verifyDeviceChallengeSignature(
  context: DeviceAuthContext,
  signature: string,
  crypto: WebCryptoLike = getWebCrypto(),
): Promise<boolean> {
  try {
    const publicKey = await importDevicePublicKey(context.devicePublicKey, crypto);
    return await crypto.subtle.verify(
      DEVICE_SIGN_ALGORITHM,
      publicKey,
      fromBase64Url(signature),
      deviceAuthPayload(context),
    );
  } catch {
    return false;
  }
}
