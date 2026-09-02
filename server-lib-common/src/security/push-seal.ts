/**
 * Sealed Web Push payloads (`docs/specs/remote-security-model.md` -> Push
 * sealing).
 *
 * A push is the one message the two endpoints exchange with no live Noise
 * session between them: the Host is awake, the phone is asleep, and the Server
 * is a store-and-forward relay that must learn nothing. So this is a
 * standalone, domain-separated seal from the two long-term statics the pair
 * already pinned at pairing — the Host's Noise static and that Client's
 * per-Host static — and **never a Noise `CipherState`**.
 *
 * Why it cannot be one: a `CipherState` is a counter plus a key from a
 * `Split`, and both sides advance it in lockstep. A push has no such shared
 * position — the phone may receive one, none, or three, in any order, days
 * apart — so reusing a transport state would either desynchronize the session
 * or reuse a nonce. This module therefore derives a **fresh key per message**
 * from a random salt and spends the all-zero nonce exactly once under it.
 *
 * The construction, in full:
 *
 *   ss  = X25519(hostStatic, clientStatic)          // WebCrypto deriveBits
 *   key = HKDF-SHA-256(ikm = ss, salt, info = domain, 32)  // WebCrypto HKDF
 *   ct  = ChaCha20-Poly1305(key, nonce = 0^12).encrypt(pt) // @noble/ciphers
 *
 * **The HKDF here is WebCrypto's, not Noise's.** `noise.ts` implements the
 * spec's own HMAC construction because interoperability demands it; nothing
 * interoperates with this envelope, so the standard primitive is the right one
 * — and using it keeps the two key schedules visibly separate. `info` is the
 * one domain string below, so a key derived here can never collide with one
 * derived for any other purpose from the same static pair.
 *
 * ChaCha20-Poly1305 comes from the same exactly-pinned `@noble/ciphers`
 * binding the Noise suite uses (`noise.ts` carries the pin and its audit note),
 * so a version bump moves both together.
 */

import {
  base64UrlLength,
  fromBase64Url,
  isBoundedBase64Url,
  isExactBase64Url,
  toBase64Url,
  utf8Encode,
} from './bytes.js';
import { NOISE_KEY_LENGTH, NOISE_TAG_LENGTH } from './noise.js';
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
 * (`lib/src/remote/host/push-delivery.ts`), whose fields are capped in code
 * points; four UTF-8 bytes per code point plus JSON's own punctuation is what
 * this number is sized from, with room to spare. Enforced on seal so a Host can
 * never mint an envelope its own guard would refuse.
 */
export const MAX_SEALED_PUSH_PLAINTEXT_LENGTH = 1536;

/**
 * Longest `ct` this guard accepts, base64url characters — the plaintext bound
 * plus the Poly1305 tag.
 *
 * A Web Push payload is limited to about 4 KB by every push service, and the
 * envelope on the wire is this ciphertext plus a `hostId`, a salt, and a
 * version. Keeping the ciphertext here leaves the whole envelope near 2 KB,
 * comfortably inside that ceiling with no per-service tuning.
 */
export const MAX_SEALED_PUSH_LENGTH = base64UrlLength(
  MAX_SEALED_PUSH_PLAINTEXT_LENGTH + NOISE_TAG_LENGTH,
);

/** Shortest possible `ct`: an empty plaintext is still a Poly1305 tag. */
const MIN_SEALED_PUSH_LENGTH = base64UrlLength(NOISE_TAG_LENGTH);

/** The 96-bit nonce, spent exactly once because the key is minted per message. */
const ZERO_NONCE = new Uint8Array(12);

/** The sealed envelope, as it travels through the Server. */
export interface SealedPushV1 {
  readonly v: 1;
  /** The HKDF salt: 32 fresh random bytes, base64url. */
  readonly salt: string;
  /** ChaCha20-Poly1305 ciphertext with its tag, base64url. */
  readonly ct: string;
}

/**
 * Shape and bounds only — a value that passes still fails to open unless it was
 * sealed by the pinned Host to this exact Client.
 *
 * Exact lengths, not ranges: the salt is one fixed size and a different one is
 * a value nothing this side produced. The ciphertext bound is what keeps a
 * relay from asking a Server to forward, or a worker to decrypt, an
 * unboundedly large blob.
 */
export function isSealedPushV1(value: unknown): value is SealedPushV1 {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.v === 1 &&
    isExactBase64Url(candidate.salt, base64UrlLength(PUSH_SEAL_SALT_LENGTH)) &&
    isBoundedBase64Url(candidate.ct, MAX_SEALED_PUSH_LENGTH) &&
    (candidate.ct as string).length >= MIN_SEALED_PUSH_LENGTH
  );
}

export interface SealPushRequest {
  /** The Host's Noise static, a nonextractable `deriveBits` key. */
  readonly hostStaticPrivateKey: CryptoKeyLike;
  /** The recipient's per-Host static, raw 32 bytes. */
  readonly clientStaticPublicKey: Uint8Array;
  readonly plaintext: Uint8Array;
}

export interface OpenPushRequest {
  /** This Client's per-Host static, a nonextractable `deriveBits` key. */
  readonly clientStaticPrivateKey: CryptoKeyLike;
  /** The pinned Host Noise static, raw 32 bytes. */
  readonly hostStaticPublicKey: Uint8Array;
  readonly sealed: SealedPushV1;
}

/**
 * Seal one notification to one Client.
 *
 * Throws on a plaintext past the bound or on any crypto failure: this runs on
 * the Host, where a failure is a bug in our own code rather than attacker
 * input, and a silent `null` would ship a push nobody can read.
 */
export async function sealPush(
  { hostStaticPrivateKey, clientStaticPublicKey, plaintext }: SealPushRequest,
  crypto: WebCryptoLike = getWebCrypto(),
): Promise<SealedPushV1> {
  if (plaintext.length > MAX_SEALED_PUSH_PLAINTEXT_LENGTH) {
    throw new Error('sealed push plaintext is too long');
  }
  const salt = crypto.getRandomValues(new Uint8Array(PUSH_SEAL_SALT_LENGTH));
  const key = await sealKey(crypto, hostStaticPrivateKey, clientStaticPublicKey, salt);
  const ct = chacha20poly1305(key, ZERO_NONCE).encrypt(plaintext);
  return { v: 1, salt: toBase64Url(salt), ct: toBase64Url(ct) };
}

/**
 * Open one sealed notification, or `null`.
 *
 * **Never throws.** Its input arrives from a push service by way of a Server
 * that may have substituted anything at all, and its caller is a service worker
 * that must answer every delivery with a visible notification
 * (`docs/specs/pocket-app.md` -> Installable web app). Every failure — a wrong
 * key, a tampered byte, a degenerate DH, a runtime without X25519 — is the same
 * `null`, which the worker renders as the generic notice.
 */
export async function openPush(
  { clientStaticPrivateKey, hostStaticPublicKey, sealed }: OpenPushRequest,
  crypto: WebCryptoLike = getWebCrypto(),
): Promise<Uint8Array | null> {
  try {
    if (!isSealedPushV1(sealed)) return null;
    const salt = fromBase64Url(sealed.salt);
    const key = await sealKey(crypto, clientStaticPrivateKey, hostStaticPublicKey, salt);
    return chacha20poly1305(key, ZERO_NONCE).decrypt(fromBase64Url(sealed.ct));
  } catch {
    return null;
  }
}

/**
 * The per-message key both sides derive: X25519 to the shared secret, then
 * WebCrypto HKDF under this module's own domain.
 *
 * An all-zero shared secret is a hard failure rather than a key, exactly as it
 * is in the handshake (`docs/specs/remote-security-model.md` -> Noise suite):
 * a peer that presented a low-order point is one whose "shared" secret every
 * other peer can compute too.
 */
async function sealKey(
  crypto: WebCryptoLike,
  privateKey: CryptoKeyLike,
  peerPublicKey: Uint8Array,
  salt: Uint8Array,
): Promise<Uint8Array> {
  if (peerPublicKey.length !== NOISE_KEY_LENGTH) {
    throw new Error('X25519 public key must be 32 bytes');
  }
  const peer = await crypto.subtle.importKey('raw', peerPublicKey, { name: 'X25519' }, false, []);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'X25519', public: peer }, privateKey, NOISE_KEY_LENGTH * 8),
  );
  if (shared.length !== NOISE_KEY_LENGTH || shared.every((byte) => byte === 0)) {
    throw new Error('X25519 agreement produced no usable shared secret');
  }
  const ikm = await crypto.subtle.importKey('raw', shared, { name: 'HKDF' }, false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info: utf8Encode(PUSH_SEAL_DOMAIN) },
      ikm,
      NOISE_KEY_LENGTH * 8,
    ),
  );
}
