/**
 * A Web Push request built on WebCrypto alone, for a Relay that has no Node
 * `crypto` (`docs/specs/hosted.md` -> "Relay"): RFC 8291 `aes128gcm` message
 * encryption and an RFC 8292 VAPID `ES256` JWT. The self-host Relay sends
 * through `web-push` instead (`relay/src/push.ts`); both carry the same sealed
 * envelope, which this module treats as opaque bytes.
 *
 * Pinned to the RFC 8291 Appendix A vector byte for byte
 * (`remote-lib-common/test/web-push.test.mjs`): a subtly wrong HKDF `info`
 * produces a push the phone silently fails to decrypt, with no error anywhere
 * the Relay can see.
 */

import {
  concatBytes,
  fromBase64Url,
  isExactBase64Url,
  toBase64Url,
  utf8Encode,
  writeUint32BE,
} from '../security/bytes.js';
import {
  type CryptoKeyLike,
  type CryptoKeyPairLike,
  type WebCryptoLike,
  getWebCrypto,
} from '../security/webcrypto.js';

/** A subscription's encryption keys as the browser serializes them. */
export interface WebPushKeys {
  /** The user agent's uncompressed P-256 public key. */
  readonly p256dh: string;
  /** The 16-byte authentication secret. */
  readonly auth: string;
}

/** A VAPID keypair: the uncompressed P-256 point and the scalar, unpadded base64url. */
export interface VapidKeys {
  readonly publicKey: string;
  readonly privateKey: string;
}

/** The one record's size the header declares (RFC 8188); one record carries the whole message. */
export const WEB_PUSH_RECORD_SIZE = 4096;

const SALT_LENGTH = 16;
const P256_POINT_LENGTH = 65;
const P256_SCALAR_LENGTH = 32;
const AUTH_SECRET_LENGTH = 16;
const GCM_TAG_LENGTH = 16;
/** `salt || rs || idlen || keyid`, the keyid being the sender's public key. */
const HEADER_LENGTH = SALT_LENGTH + 4 + 1 + P256_POINT_LENGTH;
/** RFC 8188's delimiter for the last (here, only) record, before no padding. */
const LAST_RECORD_DELIMITER = new Uint8Array([2]);

/**
 * Longest plaintext one message carries: the whole body, header included,
 * within one 4096-octet record, which every push service accepts (RFC 8291
 * section 4).
 */
export const MAX_WEB_PUSH_PLAINTEXT_LENGTH =
  WEB_PUSH_RECORD_SIZE - HEADER_LENGTH - LAST_RECORD_DELIMITER.length - GCM_TAG_LENGTH;

/** A VAPID JWT's lifetime; RFC 8292 caps `exp` at 24 hours ahead. */
export const VAPID_JWT_LIFETIME_S = 12 * 60 * 60;

const nul = new Uint8Array([0]);
const KEY_INFO_PREFIX = concatBytes(utf8Encode('WebPush: info'), nul);
const CEK_INFO = concatBytes(utf8Encode('Content-Encoding: aes128gcm'), nul);
const NONCE_INFO = concatBytes(utf8Encode('Content-Encoding: nonce'), nul);

const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const ES256 = { name: 'ECDSA', hash: 'SHA-256' };

/** A P-256 private key as JWK, the one import format WebCrypto offers for a bare scalar. */
interface P256PrivateJwk {
  readonly kty: 'EC';
  readonly crv: 'P-256';
  readonly d: string;
  readonly x: string;
  readonly y: string;
}

/** The WebCrypto calls this module makes beyond `SubtleCryptoLike`. */
interface WebPushSubtle {
  importKey(
    format: 'raw',
    keyData: Uint8Array,
    algorithm: object,
    extractable: boolean,
    usages: readonly string[],
  ): Promise<CryptoKeyLike>;
  importKey(
    format: 'jwk',
    keyData: P256PrivateJwk,
    algorithm: object,
    extractable: boolean,
    usages: readonly string[],
  ): Promise<CryptoKeyLike>;
  generateKey(
    algorithm: object,
    extractable: boolean,
    usages: readonly string[],
  ): Promise<CryptoKeyPairLike>;
  exportKey(format: 'raw', key: CryptoKeyLike): Promise<ArrayBuffer>;
  deriveBits(algorithm: object, baseKey: CryptoKeyLike, length: number): Promise<ArrayBuffer>;
  encrypt(algorithm: object, key: CryptoKeyLike, data: Uint8Array): Promise<ArrayBuffer>;
  sign(algorithm: object, key: CryptoKeyLike, data: Uint8Array): Promise<ArrayBuffer>;
  verify(
    algorithm: object,
    key: CryptoKeyLike,
    signature: Uint8Array,
    data: Uint8Array,
  ): Promise<boolean>;
}

const subtleOf = (crypto: WebCryptoLike) => crypto.subtle as unknown as WebPushSubtle;

/** A raw P-256 keypair, the scalar and its uncompressed point. */
export interface RawP256KeyPair {
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array;
}

export interface WebPushEncryptOptions {
  readonly crypto?: WebCryptoLike;
  /**
   * The test hook in this module: supply the salt and the sender's ephemeral
   * keypair instead of generating them, so a published vector can be
   * replayed. Production callers never pass either.
   */
  readonly salt?: Uint8Array;
  readonly senderKeyPair?: RawP256KeyPair;
}

/**
 * Encrypts `plaintext` to one subscription as an RFC 8291 `aes128gcm` body:
 * ECDH with a fresh sender key, HKDF over the subscription's auth secret and
 * both public keys, then one AES-128-GCM record under a fresh salt. Throws on
 * malformed subscription keys or a plaintext past
 * {@link MAX_WEB_PUSH_PLAINTEXT_LENGTH}.
 */
export async function encryptWebPush(
  plaintext: Uint8Array,
  keys: WebPushKeys,
  options: WebPushEncryptOptions = {},
): Promise<Uint8Array> {
  const crypto = options.crypto ?? getWebCrypto();
  const subtle = subtleOf(crypto);
  const uaPublic = decodeP256dh(keys.p256dh);
  if (!uaPublic) throw new Error('p256dh is not an uncompressed P-256 point');
  const authSecret = decodeAuthSecret(keys.auth);
  if (!authSecret) throw new Error(`auth must decode to ${AUTH_SECRET_LENGTH} bytes`);
  if (plaintext.length > MAX_WEB_PUSH_PLAINTEXT_LENGTH) {
    throw new Error(`push payload exceeds ${MAX_WEB_PUSH_PLAINTEXT_LENGTH} bytes`);
  }
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  if (salt.length !== SALT_LENGTH) throw new Error('salt must be 16 bytes');

  let senderPrivate: CryptoKeyLike;
  let senderPublic: Uint8Array;
  if (options.senderKeyPair) {
    senderPrivate = await importP256Private(subtle, options.senderKeyPair, ECDH, ['deriveBits']);
    senderPublic = options.senderKeyPair.publicKey;
  } else {
    const pair = await subtle.generateKey(ECDH, false, ['deriveBits']);
    senderPrivate = pair.privateKey;
    senderPublic = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  }

  const uaKey = await subtle.importKey('raw', uaPublic, ECDH, false, []);
  const ecdhSecret = new Uint8Array(
    await subtle.deriveBits({ ...ECDH, public: uaKey }, senderPrivate, 256),
  );
  const keyInfo = concatBytes(KEY_INFO_PREFIX, uaPublic, senderPublic);
  const ikm = await hkdf(subtle, authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(subtle, salt, ikm, CEK_INFO, 16);
  const nonce = await hkdf(subtle, salt, ikm, NONCE_INFO, 12);

  const aesKey = await subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const record = new Uint8Array(
    await subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, tagLength: GCM_TAG_LENGTH * 8 },
      aesKey,
      concatBytes(plaintext, LAST_RECORD_DELIMITER),
    ),
  );
  const header = new Uint8Array(HEADER_LENGTH);
  header.set(salt, 0);
  writeUint32BE(header, SALT_LENGTH, WEB_PUSH_RECORD_SIZE);
  header[SALT_LENGTH + 4] = P256_POINT_LENGTH;
  header.set(senderPublic, SALT_LENGTH + 5);
  return concatBytes(header, record);
}

/** Signs VAPID JWTs with one validated keypair. */
export interface VapidSigner {
  /** The public key, as `GET /api/push/config` and the `k=` parameter carry it. */
  readonly publicKey: string;
  /**
   * The `Authorization` header for a push to `endpoint`: `vapid t=<jwt>,
   * k=<publicKey>`, the JWT's `aud` the endpoint's origin, `sub` the subject,
   * and `exp` {@link VAPID_JWT_LIFETIME_S} after `nowMs`.
   */
  authorization(endpoint: string, subject: string, nowMs: number): Promise<string>;
}

/**
 * A signer for `keys`, or `null` when they are malformed or are not one
 * keypair: the private scalar must sign what the public point verifies, so
 * a mismatched pair turns push off rather than signing JWTs no push service
 * accepts.
 */
export async function vapidSigner(
  keys: VapidKeys,
  crypto: WebCryptoLike = getWebCrypto(),
): Promise<VapidSigner | null> {
  if (
    !isExactBase64Url(keys.publicKey, 87) ||
    !isExactBase64Url(keys.privateKey, 43)
  ) {
    return null;
  }
  const publicKey = decodeP256dh(keys.publicKey);
  const privateScalar = decodePushKey(keys.privateKey, P256_SCALAR_LENGTH);
  if (!publicKey || !privateScalar) return null;
  const subtle = subtleOf(crypto);
  let signingKey: CryptoKeyLike;
  try {
    signingKey = await importP256Private(subtle, { privateKey: privateScalar, publicKey }, ECDSA, [
      'sign',
    ]);
    const verifyKey = await subtle.importKey('raw', publicKey, ECDSA, false, ['verify']);
    // Node refuses a mismatched point at import; the probe holds the rule in a
    // runtime that imports one anyway.
    const probe = utf8Encode('dormouse/vapid/pair');
    const signature = new Uint8Array(await subtle.sign(ES256, signingKey, probe));
    if (!(await subtle.verify(ES256, verifyKey, signature, probe))) return null;
  } catch {
    return null;
  }
  return {
    publicKey: keys.publicKey,
    async authorization(endpoint, subject, nowMs) {
      const header = base64UrlJson({ typ: 'JWT', alg: 'ES256' });
      const claims = base64UrlJson({
        aud: new URL(endpoint).origin,
        exp: Math.floor(nowMs / 1000) + VAPID_JWT_LIFETIME_S,
        sub: subject,
      });
      const signingInput = `${header}.${claims}`;
      // WebCrypto's ECDSA signature is already JWS's `r || s`.
      const signature = new Uint8Array(
        await subtle.sign(ES256, signingKey, utf8Encode(signingInput)),
      );
      return `vapid t=${signingInput}.${toBase64Url(signature)}, k=${keys.publicKey}`;
    },
  };
}

/** What a push service is sent for one delivery, before `fetch`. */
export interface WebPushRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

/**
 * One push's headers and encrypted body: `aes128gcm`, the VAPID
 * `authorization` ({@link VapidSigner.authorization} for the endpoint's
 * origin, which one JWT serves for every endpoint there), `TTL`, and high
 * urgency, an alarm being worth waking for.
 */
export async function webPushRequest(
  keys: WebPushKeys,
  payload: Uint8Array,
  {
    authorization,
    ttlSeconds,
    ...encrypt
  }: WebPushEncryptOptions & {
    readonly authorization: string;
    readonly ttlSeconds: number;
  },
): Promise<WebPushRequest> {
  const body = await encryptWebPush(payload, keys, encrypt);
  return {
    headers: {
      authorization,
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(ttlSeconds),
      urgency: 'high',
    },
    body,
  };
}

/**
 * Hosts a push service will not accept in a VAPID subject. Apple answers
 * `403 {"reason":"BadJwtToken"}` for a loopback subject — verified against
 * `web.push.apple.com` for both `mailto:admin@localhost` and
 * `https://localhost:3000`, while `mailto:admin@example.com` and an ordinary
 * https origin were accepted. Apple does not check that the contact is
 * *reachable*, only that it is not loopback.
 */
const LOOPBACK_SUBJECT_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Whether `subject` names a loopback host: the domain half of a `mailto:`,
 * the hostname otherwise. An unparsable subject names none.
 */
export function isLoopbackVapidSubject(subject: string): boolean {
  let parsed: InstanceType<typeof URL>;
  try {
    parsed = new URL(subject);
  } catch {
    return false;
  }
  let host: string;
  if (parsed.protocol === 'mailto:') {
    const at = parsed.pathname.lastIndexOf('@');
    host = at === -1 ? '' : parsed.pathname.slice(at + 1).toLowerCase();
  } else {
    host = parsed.hostname.toLowerCase();
  }
  if (!host) return false;
  if (LOOPBACK_SUBJECT_HOSTS.has(host)) return true;
  // RFC 6761 reserves the whole `.localhost` TLD for loopback.
  if (host.endsWith('.localhost')) return true;
  return /^127\./.test(host);
}

/**
 * The `https:` operator contact to sign VAPID JWTs with (RFC 8292) by
 * default — the Relay's own origin — or `null` when this deployment has no
 * usable one and push must stay off.
 *
 * Every deployment that can serve Pocket at all already has a valid https
 * origin, because WebAuthn requires one. A loopback dev server has no such
 * contact — and could not reach a phone anyway. Returning `null` there
 * disables push rather than inventing a placeholder contact that a push
 * service may reject, which is the failure this default exists to prevent: a
 * Relay that answers 200 on send and silently delivers nothing to any iPhone.
 */
export function defaultVapidSubject(origin: string): string | null {
  let parsed: InstanceType<typeof URL>;
  try {
    parsed = new URL(origin);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (isLoopbackVapidSubject(parsed.origin)) return null;
  return parsed.origin;
}

/**
 * True if `keys` are subscription keys {@link encryptWebPush} can encrypt to:
 * `p256dh` an uncompressed point on P-256, `auth` the 16-byte secret. Both
 * Relays refuse any other at registration (`admissiblePushSubscription`). The
 * shape checks run first; only a 65-byte `0x04`-led point reaches WebCrypto,
 * whose import refuses one off the curve — a key that would otherwise register
 * and then fail every send with `DataError`, holding its row forever.
 */
export async function importableWebPushKeys(keys: {
  readonly p256dh: unknown;
  readonly auth: unknown;
}): Promise<boolean> {
  const point = decodeP256dh(keys.p256dh);
  if (!point || !decodeAuthSecret(keys.auth)) return false;
  try {
    await subtleOf(getWebCrypto()).importKey('raw', point, ECDH, false, []);
    return true;
  } catch {
    return false;
  }
}

/** A `p256dh` as its 65-byte uncompressed point (leading `0x04`), or null. */
function decodeP256dh(value: unknown): Uint8Array | null {
  const point = decodePushKey(value, P256_POINT_LENGTH);
  return point && point[0] === 4 ? point : null;
}

/** An `auth` as its 16 bytes, or null. */
function decodeAuthSecret(value: unknown): Uint8Array | null {
  return decodePushKey(value, AUTH_SECRET_LENGTH);
}

/**
 * A subscription key as browsers serialize it — base64url or base64, padded
 * or not — decoding to exactly `length` bytes, or null.
 */
function decodePushKey(value: unknown, length: number): Uint8Array | null {
  if (typeof value !== 'string') return null;
  try {
    const decoded = fromBase64Url(value.replace(/\+/g, '-').replace(/\//g, '_'));
    return decoded.length === length ? decoded : null;
  } catch {
    return null;
  }
}

/** A P-256 scalar and its point as a WebCrypto private key for `algorithm`. */
function importP256Private(
  subtle: WebPushSubtle,
  { privateKey, publicKey }: RawP256KeyPair,
  algorithm: object,
  usages: readonly string[],
): Promise<CryptoKeyLike> {
  return subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: toBase64Url(privateKey),
      x: toBase64Url(publicKey.subarray(1, 33)),
      y: toBase64Url(publicKey.subarray(33, 65)),
    },
    algorithm,
    false,
    usages,
  );
}

/** RFC 5869 HKDF-SHA-256: extract under `salt`, expand `info` to `length` bytes. */
async function hkdf(
  subtle: WebPushSubtle,
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);
  return new Uint8Array(
    await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8),
  );
}

function base64UrlJson(value: object): string {
  return toBase64Url(utf8Encode(JSON.stringify(value)));
}
