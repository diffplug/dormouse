/**
 * Sealed Web Push payloads. The construction and its rules live in
 * `docs/specs/remote-security-model.md` -> Push sealing; this file is the
 * implementation of them.
 *
 * **The HKDF here is WebCrypto's, not Noise's.** `noise.ts` implements the
 * spec's own HMAC construction because interoperability demands it; nothing
 * interoperates with this envelope, so the standard primitive is the right one
 * — and using it keeps the two key schedules visibly separate. The X25519
 * agreement underneath is shared with the handshake (`x25519Agree`), so both
 * reject the same degenerate points. ChaCha20-Poly1305 comes from the same
 * exactly-pinned `@noble/ciphers` binding, so a version bump moves both.
 */

import {
  base64UrlLength,
  fromBase64Url,
  isBoundedBase64Url,
  isExactBase64Url,
  toBase64Url,
  utf8Encode,
} from './bytes.js';
import { NOISE_KEY_LENGTH, NOISE_TAG_LENGTH, x25519Agree } from './noise.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { type CryptoKeyLike, type WebCryptoLike, getWebCrypto } from './webcrypto.js';

/** HKDF `info`, and the whole of this construction's domain separation. */
export const PUSH_SEAL_DOMAIN = 'dormouse/push/v1';

/** Bytes of fresh randomness per sealed message; also the HKDF salt length. */
export const PUSH_SEAL_SALT_LENGTH = 32;

/**
 * Longest plaintext this seal will carry, in bytes.
 *
 * The plaintext is the JSON of one bounded `{ title, body, tag }`
 * (`lib/src/remote/burrow/push-delivery.ts`), whose fields are capped in code
 * points; four UTF-8 bytes per code point plus JSON's own punctuation is what
 * this number is sized from, with room to spare. Enforced on seal so a Burrow can
 * never mint an envelope its own guard would refuse.
 */
export const MAX_SEALED_PUSH_PLAINTEXT_LENGTH = 1536;

/**
 * Longest `ct` this guard accepts, base64url characters — the plaintext bound
 * plus the Poly1305 tag.
 *
 * A Web Push payload is limited to about 4 KB by every push service, and the
 * envelope on the wire is this ciphertext plus a `burrowId`, a salt, and a
 * version. Keeping the ciphertext here leaves the whole envelope near 2 KB,
 * comfortably inside that ceiling with no per-service tuning.
 */
export const MAX_SEALED_PUSH_LENGTH = base64UrlLength(
  MAX_SEALED_PUSH_PLAINTEXT_LENGTH + NOISE_TAG_LENGTH,
);

/** Shortest possible `ct`: an empty plaintext is still a Poly1305 tag. */
const MIN_SEALED_PUSH_LENGTH = base64UrlLength(NOISE_TAG_LENGTH);

/** The one `salt` length on the wire, in base64url characters. */
const SEALED_PUSH_SALT_CHARS = base64UrlLength(PUSH_SEAL_SALT_LENGTH);

/** The HKDF `info`, encoded once. */
const PUSH_SEAL_INFO = utf8Encode(PUSH_SEAL_DOMAIN);

/** The 96-bit nonce, spent exactly once because the key is minted per message. */
const ZERO_NONCE = new Uint8Array(12);

/** The sealed envelope, as it travels through the Relay. */
export interface SealedPushV1 {
  readonly v: 1;
  /** The HKDF salt: 32 fresh random bytes, base64url. */
  readonly salt: string;
  /** ChaCha20-Poly1305 ciphertext with its tag, base64url. */
  readonly ct: string;
}

/**
 * Shape and bounds only — a value that passes still fails to open unless it was
 * sealed by the pinned Burrow to this exact Client.
 *
 * Exact lengths, not ranges: the salt is one fixed size and a different one is
 * a value nothing this side produced. The ciphertext bound is what keeps a
 * relay from asking a Relay to forward, or a worker to decrypt, an
 * unboundedly large blob.
 */
export function isSealedPushV1(value: unknown): value is SealedPushV1 {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.v === 1 &&
    isExactBase64Url(candidate.salt, SEALED_PUSH_SALT_CHARS) &&
    isBoundedBase64Url(candidate.ct, MAX_SEALED_PUSH_LENGTH) &&
    (candidate.ct as string).length >= MIN_SEALED_PUSH_LENGTH
  );
}

export interface SealPushRequest {
  /** The Burrow's Noise static, a nonextractable `deriveBits` key. */
  readonly burrowStaticPrivateKey: CryptoKeyLike;
  /** The recipient's per-Burrow static, raw 32 bytes. */
  readonly clientStaticPublicKey: Uint8Array;
  readonly plaintext: Uint8Array;
}

export interface OpenPushRequest {
  /** This Client's per-Burrow static, a nonextractable `deriveBits` key. */
  readonly clientStaticPrivateKey: CryptoKeyLike;
  /** The pinned Burrow Noise static, raw 32 bytes. */
  readonly burrowStaticPublicKey: Uint8Array;
  readonly sealed: SealedPushV1;
}

/**
 * Seal one notification to one Client.
 *
 * Throws on a plaintext past the bound or on any crypto failure: this runs on
 * the Burrow, where a failure is a bug in our own code rather than attacker
 * input, and a silent `null` would ship a push nobody can read.
 */
export async function sealPush(
  { burrowStaticPrivateKey, clientStaticPublicKey, plaintext }: SealPushRequest,
  crypto: WebCryptoLike = getWebCrypto(),
): Promise<SealedPushV1> {
  if (plaintext.length > MAX_SEALED_PUSH_PLAINTEXT_LENGTH) {
    throw new Error('sealed push plaintext is too long');
  }
  const salt = crypto.getRandomValues(new Uint8Array(PUSH_SEAL_SALT_LENGTH));
  const key = await sealKey(crypto, burrowStaticPrivateKey, clientStaticPublicKey, salt);
  const ct = chacha20poly1305(key, ZERO_NONCE).encrypt(plaintext);
  return { v: 1, salt: toBase64Url(salt), ct: toBase64Url(ct) };
}

/**
 * Open one sealed notification, or `null`.
 *
 * **Never throws.** Its input arrives from a push service by way of a Relay
 * that may have substituted anything at all, and its caller is a service worker
 * that must answer every delivery with a visible notification
 * (`docs/specs/pocket-app.md` -> Installable web app). Every failure — a wrong
 * key, a tampered byte, a degenerate DH, a runtime without X25519 — is the same
 * `null`, which the worker renders as the generic notice.
 */
export async function openPush(
  { clientStaticPrivateKey, burrowStaticPublicKey, sealed }: OpenPushRequest,
  crypto: WebCryptoLike = getWebCrypto(),
): Promise<Uint8Array | null> {
  try {
    if (!isSealedPushV1(sealed)) return null;
    const salt = fromBase64Url(sealed.salt);
    const key = await sealKey(crypto, clientStaticPrivateKey, burrowStaticPublicKey, salt);
    return chacha20poly1305(key, ZERO_NONCE).decrypt(fromBase64Url(sealed.ct));
  } catch {
    return null;
  }
}

/**
 * The per-message key both sides derive: X25519 to the shared secret — the same
 * `x25519Agree` the handshake runs, so a low-order point is one indistinguishable
 * failure in both — then WebCrypto HKDF under this module's own domain.
 */
async function sealKey(
  crypto: WebCryptoLike,
  privateKey: CryptoKeyLike,
  peerPublicKey: Uint8Array,
  salt: Uint8Array,
): Promise<Uint8Array> {
  const shared = await x25519Agree(crypto, privateKey, peerPublicKey);
  const ikm = await crypto.subtle.importKey('raw', shared, { name: 'HKDF' }, false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info: PUSH_SEAL_INFO },
      ikm,
      NOISE_KEY_LENGTH * 8,
    ),
  );
}
