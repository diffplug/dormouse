import { createECDH } from "node:crypto";

/**
 * A VAPID pair as the relay's two secrets hold it, from the first scalar
 * `scalarFor(0)`, `scalarFor(1)`, … that is a valid P-256 private key (a
 * digest is not, about one time in 2^32): the uncompressed point and the
 * scalar, unpadded base64url.
 */
export function vapidKeysFrom(scalarFor) {
  for (let counter = 0; ; counter++) {
    const scalar = scalarFor(counter);
    const ecdh = createECDH("prime256v1");
    try {
      ecdh.setPrivateKey(scalar);
    } catch {
      continue;
    }
    return {
      RELAY_VAPID_PUBLIC_KEY: ecdh.getPublicKey().toString("base64url"),
      RELAY_VAPID_PRIVATE_KEY: scalar.toString("base64url"),
    };
  }
}
