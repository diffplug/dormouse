/**
 * Does this runtime have the one primitive the Noise suite cannot do without?
 * (`docs/specs/remote-security-model.md` -> E2E identities and presence.)
 *
 * X25519 is WebCrypto-only by design — a long-term private key stays a
 * nonextractable `CryptoKey` — so a runtime without it cannot run the protocol
 * at all. The answer is a boolean rather than an exception because the callers
 * this exists for are gates: they show a fixed upgrade requirement and perform
 * no remote operation.
 */

import { getWebCrypto, type WebCryptoLike } from './webcrypto.js';

const X25519_ALGORITHM = { name: 'X25519' } as const;

/** Raw X25519 keys and shared secrets are 32 bytes. */
const X25519_KEY_LENGTH = 32;

/**
 * Whether X25519 `generateKey` and `deriveBits` both work here.
 *
 * **Never throws and never rejects.** Every way a runtime can say no — a
 * missing `globalThis.crypto`, an unrecognized algorithm, a policy that
 * refuses key generation, an agreement that fails — is the same `false`, since
 * a caller deciding whether to offer remote control has nothing to do with the
 * distinction. The `crypto` parameter is resolved inside that guard rather
 * than as a default argument, so a runtime with no WebCrypto at all is
 * answered rather than rejected.
 */
export async function probeNoiseSupport(crypto?: WebCryptoLike): Promise<boolean> {
  try {
    const webCrypto = crypto ?? getWebCrypto();
    // One generate and one agreement — the exact pair the handshake needs.
    // Agreeing with its own public half is a real X25519 operation and needs
    // no second keypair.
    const pair = await webCrypto.subtle.generateKey(X25519_ALGORITHM, false, ['deriveBits']);
    const shared = await webCrypto.subtle.deriveBits(
      { name: 'X25519', public: pair.publicKey },
      pair.privateKey,
      X25519_KEY_LENGTH * 8,
    );
    return shared.byteLength === X25519_KEY_LENGTH;
  } catch {
    return false;
  }
}
