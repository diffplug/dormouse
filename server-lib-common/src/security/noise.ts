/**
 * `Noise_IK_25519_ChaChaPoly_SHA256`, Noise revision 34
 * (https://noiseprotocol.org/noise.html) — the one suite Dormouse speaks
 * end to end (`docs/specs/remote-security-model.md` -> Noise suite).
 *
 * ChaCha20-Poly1305 is `@noble/ciphers`, bundled because no interoperable
 * WebCrypto ChaChaPoly exists, and pinned to exactly **2.4.0**.
 *
 * Audit: Cure53 audited `@noble/ciphers` **1.0.0** in **September 2024**,
 * funded by OpenSats (the report is linked from the package README). The
 * pinned 2.4.0 is one major and several minor releases past the audited code.
 *
 * What changed in the ChaCha20-Poly1305 path between 1.0.0 and 2.4.0 — read
 * from the GitHub release notes and by diffing `src/_arx.ts`, `src/chacha.ts`,
 * and `src/_poly1305.ts` of both published tarballs (2026-09-01): the ARX
 * round function and the Poly1305 field arithmetic are unchanged; every
 * difference is around them.
 *   - Argument validation moved into `wrapCipher`, and a cipher instance may
 *     be used only once (1.1.0).
 *   - Output-buffer handling: unaligned outputs fixed and outputs zeroized
 *     before use (1.1.1); input/output overlap prohibited (1.1.2, relaxed back
 *     for chachapoly in 1.1.3); partially-overlapping output buffers rejected
 *     (2.4.0).
 *   - Inputs are copied before use, and MAC input must be `Uint8Array` —
 *     strings are no longer accepted (2.0.0).
 *   - Big-endian hosts handled explicitly (`swap32IfBE`) and zeroization
 *     tightened (2.2.0).
 *   - Passing AAD to a cipher that does not support it throws instead of being
 *     silently ignored (2.3.0); ChaCha20-Poly1305 supports AAD, so this suite
 *     is unaffected.
 *   - Packaging and typing churn: ESM-only with `.js` specifiers, the `_micro`
 *     reference implementation removed, `Uint8Array` generics fixed (2.0.0,
 *     2.2.0).
 * The maintainer records a March 2026 *self*-audit of all files in the 2.2.0
 * notes ("no major issues found"); that is not an independent review.
 */

import { chacha20poly1305 } from '@noble/ciphers/chacha.js';

import {
  base64UrlLength,
  concatBytes,
  constantTimeEqual,
  fromBase64Url,
  isExactBase64Url,
  toBase64Url,
  utf8Encode,
} from './bytes.js';
import {
  type CryptoKeyLike,
  type CryptoKeyPairLike,
  type WebCryptoLike,
  getWebCrypto,
} from './webcrypto.js';

/** The only protocol name this module implements. */
export const NOISE_PROTOCOL_NAME = 'Noise_IK_25519_ChaChaPoly_SHA256';

/** Noise's maximum message length; every handshake message is capped at it. */
export const NOISE_MAX_MESSAGE_LENGTH = 65535;

/** Raw X25519 public keys, SHA-256 digests, and ChaChaPoly keys are all 32 bytes. */
export const NOISE_KEY_LENGTH = 32;

/**
 * Poly1305 authentication tag length. Exported because the transport framing
 * budgets against it: a stream body plus its kind byte plus this must stay
 * inside {@link NOISE_MAX_MESSAGE_LENGTH} (`noise-transport.ts`).
 */
export const NOISE_TAG_LENGTH = 16;

/**
 * Bytes each handshake message spends on framing, so its length is exactly
 * `OVERHEAD + payload.length`. These are the only encoding of that fact: the
 * writers cap against them and the readers reject anything shorter.
 *   1. `e` + the encrypted `s` and its tag + the payload tag.
 *   2. `e` + the payload tag.
 */
const MESSAGE_1_OVERHEAD = NOISE_KEY_LENGTH * 2 + NOISE_TAG_LENGTH * 2;
const MESSAGE_2_OVERHEAD = NOISE_KEY_LENGTH + NOISE_TAG_LENGTH;

/** `2^64 - 1` is reserved by the Noise spec: reaching it exhausts the counter. */
const RESERVED_NONCE = 0xffffffffffffffffn;

const X25519_ALGORITHM = { name: 'X25519' } as const;
const HMAC_ALGORITHM = { name: 'HMAC', hash: 'SHA-256' } as const;

const EMPTY = new Uint8Array(0);
const ZERO_KEY = new Uint8Array(NOISE_KEY_LENGTH);

/** Every failure in this module — handshake, transport, or counter. */
export class NoiseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoiseError';
  }
}

/**
 * An X25519 keypair as this module uses it: a (normally nonextractable)
 * private `CryptoKey` plus its raw 32-byte public half, which Noise puts on
 * the wire and mixes into the transcript.
 */
export interface NoiseKeyPair {
  readonly privateKey: CryptoKeyLike;
  readonly publicKey: Uint8Array;
}

/** The two directional cipher states and the transcript hash from `Split`. */
export interface NoiseSession {
  readonly send: NoiseCipherState;
  readonly receive: NoiseCipherState;
  readonly handshakeHash: Uint8Array;
}

/**
 * Whether X25519 `generateKey` and `deriveBits` both work here — the one
 * primitive the suite cannot do without, so a runtime answering `false` cannot
 * run the protocol at all.
 *
 * **Never throws and never rejects**, a missing `globalThis.crypto` included:
 * the callers this exists for are boot-path gates that show a fixed upgrade
 * requirement and perform no remote operation
 * (`docs/specs/remote-security-model.md` -> Host identity). The default is
 * resolved inside the guard for the same reason.
 */
export async function probeNoiseSupport(crypto?: WebCryptoLike): Promise<boolean> {
  try {
    const webCrypto = crypto ?? getWebCrypto();
    // Agreeing with its own public half is a real X25519 operation, so the
    // exact pair the handshake needs is covered without a second keypair.
    const { pair } = await generateX25519(webCrypto, false);
    const shared = await webCrypto.subtle.deriveBits(
      { ...X25519_ALGORITHM, public: pair.publicKey },
      pair.privateKey,
      NOISE_KEY_LENGTH * 8,
    );
    return shared.byteLength === NOISE_KEY_LENGTH;
  } catch {
    return false;
  }
}

/**
 * Generate an X25519 keypair whose private half never leaves WebCrypto. A
 * runtime without X25519 rejects here, so the failure is a `NoiseError` like
 * every other in this module rather than a bare `DOMException` a caller's
 * `instanceof NoiseError` branch would miss.
 */
export async function generateNoiseKeyPair(
  crypto: WebCryptoLike = getWebCrypto(),
): Promise<NoiseKeyPair> {
  const { pair, publicKey } = await generateX25519(crypto, false);
  return { privateKey: pair.privateKey, publicKey };
}

/**
 * One X25519 keypair with its public half already raw. `extractable` is the
 * only axis callers differ on, and it is `true` for exactly one of them
 * ({@link mintNoiseStaticKeyPair}).
 */
async function generateX25519(
  crypto: WebCryptoLike,
  extractable: boolean,
): Promise<{ pair: CryptoKeyPairLike; publicKey: Uint8Array }> {
  let pair: CryptoKeyPairLike;
  let publicKey: Uint8Array;
  try {
    pair = await crypto.subtle.generateKey(X25519_ALGORITHM, extractable, ['deriveBits']);
    publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  } catch {
    throw new NoiseError('X25519 key generation failed');
  }
  if (publicKey.length !== NOISE_KEY_LENGTH) {
    throw new NoiseError('X25519 public key is not 32 bytes');
  }
  return { pair, publicKey };
}

/**
 * A Noise static keypair in the form something has to persist it in: the
 * private half as PKCS#8 and the public half raw, both base64url.
 *
 * Only a *long-term* static is ever exported. Ephemerals and imported statics
 * stay nonextractable `CryptoKey`s; this shape exists because a Host must come
 * back as the same party after a restart, and its state file is the only place
 * that can remember.
 */
export interface NoiseStaticKeyMaterial {
  /** PKCS#8 of the X25519 private key, base64url. Never leaves the machine. */
  readonly privateKeyPkcs8: string;
  /** The raw 32-byte public key, base64url. */
  readonly publicKey: string;
}

/**
 * The decoded byte length a stored
 * {@link NoiseStaticKeyMaterial.privateKeyPkcs8} must fall within: canonical
 * X25519 PKCS#8 is 48 bytes, and the ceiling leaves room for a runtime that
 * also encodes the optional public-key attribute. The point of checking is to
 * bound what a state file can hand `importKey`.
 */
const NOISE_STATIC_PKCS8_MIN_LENGTH = 48;
const NOISE_STATIC_PKCS8_MAX_LENGTH = 128;

/**
 * Mint a static keypair for persistence: generated extractable exactly once,
 * exported, and never held in that form.
 *
 * The returned private key is the one secret in this module that exists
 * outside WebCrypto, so the caller owns getting it to owner-only storage and
 * nowhere else — in particular, never to the Server.
 */
export async function mintNoiseStaticKeyPair(
  crypto: WebCryptoLike = getWebCrypto(),
): Promise<NoiseStaticKeyMaterial> {
  const { pair, publicKey } = await generateX25519(crypto, true);
  let pkcs8: Uint8Array;
  try {
    pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  } catch {
    throw new NoiseError('X25519 static key generation failed');
  }
  return { privateKeyPkcs8: toBase64Url(pkcs8), publicKey: toBase64Url(publicKey) };
}

/**
 * Whether a value is base64url of a raw 32-byte X25519 public key.
 *
 * **Shape only, and required before a key is pinned.** A peer that names a
 * static of any other length is one whose key nothing can import, so a store
 * that keeps it holds a pin no later handshake can ever be built from — the
 * failure surfaces at the *next* attempt, far from the outcome that caused it.
 */
export function isNoisePublicKey(value: unknown): value is string {
  return isExactBase64Url(value, base64UrlLength(NOISE_KEY_LENGTH));
}

/**
 * Whether a persisted {@link NoiseStaticKeyMaterial} is well-formed enough to
 * hand back to {@link importNoiseStaticPrivateKey}: both halves base64url, the
 * public one 32 bytes, the private one a PKCS#8-sized blob.
 *
 * **Shape only.** It does not derive the public point from the private half,
 * so two halves of different keypairs pass — a synchronous guard cannot do the
 * agreement, and what it is defending against is a truncated write, not a
 * forger who already has write access to the state file.
 *
 * Lives here, beside what mints and imports it, so every store that persists a
 * static checks it the same way rather than growing its own copy.
 */
export function isNoiseStaticMaterial(publicKey: string, privateKeyPkcs8: string): boolean {
  try {
    const pkcs8Length = fromBase64Url(privateKeyPkcs8).length;
    return (
      fromBase64Url(publicKey).length === NOISE_KEY_LENGTH &&
      pkcs8Length >= NOISE_STATIC_PKCS8_MIN_LENGTH &&
      pkcs8Length <= NOISE_STATIC_PKCS8_MAX_LENGTH
    );
  } catch {
    return false;
  }
}

/**
 * The public half of a persisted static, derived from the private one.
 *
 * Whatever first consumes a Host static checks that its halves correspond: two
 * halves of different keypairs pass {@link isNoiseStaticMaterial}, which is
 * shape only, and a mismatch would read as a *changed Host identity* at every
 * paired Client rather than as the corrupt state file it is
 * (`docs/specs/remote-security-model.md` → Host identity).
 *
 * The private key is imported extractable for exactly this call and discarded;
 * the copy the Host actually holds still comes from
 * {@link importNoiseStaticPrivateKey}. JWK is the only WebCrypto route from an
 * X25519 private key to its public point — `deriveBits` yields a shared secret,
 * never the point — and `x` is the raw public key in unpadded base64url, which
 * is the encoding this module already persists.
 */
export async function deriveNoiseStaticPublicKey(
  privateKeyPkcs8: string,
  crypto: WebCryptoLike = getWebCrypto(),
): Promise<string> {
  try {
    const temporary = await crypto.subtle.importKey(
      'pkcs8',
      fromBase64Url(privateKeyPkcs8),
      X25519_ALGORITHM,
      true,
      ['deriveBits'],
    );
    const jwk = await crypto.subtle.exportKey('jwk', temporary);
    if (typeof jwk.x !== 'string' || fromBase64Url(jwk.x).length !== NOISE_KEY_LENGTH) {
      throw new Error('no public point');
    }
    // Re-encoded rather than returned as the runtime spelled it: a JWK `x` is
    // base64url by contract, but only this round trip makes it the same
    // canonical string the enrollment stored.
    return toBase64Url(fromBase64Url(jwk.x));
  } catch {
    throw new NoiseError('X25519 static public key could not be derived');
  }
}

/**
 * Load a persisted static back as a **nonextractable** `deriveBits` key.
 *
 * Nonextractable is the whole point of the round trip: the exported form
 * exists so a restart can recover the identity, and once it is a `CryptoKey`
 * again nothing — including a bug in the process holding it — can export it a
 * second time.
 */
export async function importNoiseStaticPrivateKey(
  pkcs8Base64Url: string,
  crypto: WebCryptoLike = getWebCrypto(),
): Promise<CryptoKeyLike> {
  try {
    return await crypto.subtle.importKey(
      'pkcs8',
      fromBase64Url(pkcs8Base64Url),
      X25519_ALGORITHM,
      false,
      ['deriveBits'],
    );
  } catch {
    throw new NoiseError('X25519 static private key could not be imported');
  }
}

/**
 * The 96-bit ChaChaPoly nonce for counter `n`: four zero bytes followed by `n`
 * little-endian. Every encrypt and decrypt goes through here, so throwing on
 * the reserved `2^64 - 1` is what makes counter exhaustion a hard error.
 */
export function noiseNonceBytes(n: bigint): Uint8Array {
  if (n < 0n) throw new NoiseError('nonce counter must not be negative');
  if (n >= RESERVED_NONCE) throw new NoiseError('nonce counter exhausted');
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, n, true);
  return nonce;
}

/** Noise `CipherState`: a key and a counter. */
export class NoiseCipherState {
  readonly #key: Uint8Array | undefined;
  #n = 0n;

  constructor(key?: Uint8Array) {
    if (key !== undefined && key.length !== NOISE_KEY_LENGTH) {
      throw new NoiseError('ChaChaPoly key must be 32 bytes');
    }
    this.#key = key;
  }

  /** Whether `InitializeKey` was given a key; an empty state is a passthrough. */
  get hasKey(): boolean {
    return this.#key !== undefined;
  }

  /** The next counter value this state will use. */
  get nonce(): bigint {
    return this.#n;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    // Noise's 65535-byte cap is on the message, so the tag counts. Enforced on
    // the sending side because an over-length frame is silent here and only
    // fails at the conformant peer, which cannot tell the sender why.
    requireMaxMessageLength(plaintext.length + (this.#key === undefined ? 0 : NOISE_TAG_LENGTH));
    if (this.#key === undefined) return plaintext;
    const nonce = noiseNonceBytes(this.#n);
    const ciphertext = chacha20poly1305(this.#key, nonce, ad).encrypt(plaintext);
    this.#n += 1n;
    return ciphertext;
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    requireMaxMessageLength(ciphertext.length);
    if (this.#key === undefined) return ciphertext;
    const nonce = noiseNonceBytes(this.#n);
    let plaintext: Uint8Array;
    try {
      plaintext = chacha20poly1305(this.#key, nonce, ad).decrypt(ciphertext);
    } catch {
      // Do not advance: an attacker who can inject one bad frame must not be
      // able to desynchronize the counter and lock out the real sender.
      throw new NoiseError('ChaChaPoly authentication failed');
    }
    this.#n += 1n;
    return plaintext;
  }
}

async function sha256(crypto: WebCryptoLike, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

async function importHmacKey(crypto: WebCryptoLike, key: Uint8Array): Promise<CryptoKeyLike> {
  return await crypto.subtle.importKey('raw', key, HMAC_ALGORITHM, false, ['sign']);
}

async function hmacSha256(
  crypto: WebCryptoLike,
  key: CryptoKeyLike,
  data: Uint8Array,
): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign(HMAC_ALGORITHM, key, data));
}

/**
 * Noise's HKDF (section 4.3) with two outputs. Not WebCrypto HKDF: the
 * chaining key is the HMAC key and there is no info string.
 */
async function noiseHkdf(
  crypto: WebCryptoLike,
  chainingKey: Uint8Array,
  inputKeyMaterial: Uint8Array,
): Promise<readonly [Uint8Array, Uint8Array]> {
  const chainKey = await importHmacKey(crypto, chainingKey);
  const tempKey = await importHmacKey(
    crypto,
    await hmacSha256(crypto, chainKey, inputKeyMaterial),
  );
  const output1 = await hmacSha256(crypto, tempKey, Uint8Array.of(0x01));
  const output2 = await hmacSha256(crypto, tempKey, concatBytes(output1, Uint8Array.of(0x02)));
  return [output1, output2];
}

/** Noise `SymmetricState`, specialized to SHA-256 (so `HASHLEN` is 32). */
class SymmetricState {
  readonly #crypto: WebCryptoLike;
  #chainingKey: Uint8Array;
  #hash: Uint8Array;
  #cipher = new NoiseCipherState();

  private constructor(crypto: WebCryptoLike, hash: Uint8Array) {
    this.#crypto = crypto;
    this.#chainingKey = hash;
    this.#hash = hash;
  }

  /**
   * `InitializeSymmetric`. The spec hashes a protocol name longer than HASHLEN
   * and zero-pads a shorter one; this name is exactly HASHLEN, so the guard
   * makes a name edit fail loudly rather than silently taking the wrong branch.
   */
  static initialize(crypto: WebCryptoLike): SymmetricState {
    const name = utf8Encode(NOISE_PROTOCOL_NAME);
    if (name.length > NOISE_KEY_LENGTH) throw new NoiseError('protocol name exceeds HASHLEN');
    const hash = new Uint8Array(NOISE_KEY_LENGTH);
    hash.set(name);
    return new SymmetricState(crypto, hash);
  }

  get handshakeHash(): Uint8Array {
    return this.#hash;
  }

  async mixHash(data: Uint8Array): Promise<void> {
    this.#hash = await sha256(this.#crypto, concatBytes(this.#hash, data));
  }

  async mixKey(inputKeyMaterial: Uint8Array): Promise<void> {
    const [chainingKey, temporaryKey] = await noiseHkdf(
      this.#crypto,
      this.#chainingKey,
      inputKeyMaterial,
    );
    this.#chainingKey = chainingKey;
    this.#cipher = new NoiseCipherState(temporaryKey);
  }

  async encryptAndHash(plaintext: Uint8Array): Promise<Uint8Array> {
    const ciphertext = this.#cipher.encryptWithAd(this.#hash, plaintext);
    await this.mixHash(ciphertext);
    return ciphertext;
  }

  async decryptAndHash(ciphertext: Uint8Array): Promise<Uint8Array> {
    const plaintext = this.#cipher.decryptWithAd(this.#hash, ciphertext);
    await this.mixHash(ciphertext);
    return plaintext;
  }

  async split(initiator: boolean): Promise<NoiseSession> {
    const [k1, k2] = await noiseHkdf(this.#crypto, this.#chainingKey, EMPTY);
    return {
      send: new NoiseCipherState(initiator ? k1 : k2),
      receive: new NoiseCipherState(initiator ? k2 : k1),
      handshakeHash: this.#hash.slice(),
    };
  }
}

/** Options shared by both roles. */
export interface NoiseHandshakeOptions {
  /** Prologue bytes; both sides must supply byte-identical values. */
  readonly prologue: Uint8Array;
  /** The local long-term static keypair (`s`). */
  readonly staticKeyPair: NoiseKeyPair;
  readonly crypto?: WebCryptoLike;
  /**
   * The one test hook in this module: supply `e` instead of generating it, so
   * a published vector can be replayed. Production callers never pass it.
   */
  readonly ephemeralKeyPair?: NoiseKeyPair;
}

/** The initiator additionally knows the responder's static public key (`rs`). */
export interface NoiseInitiatorOptions extends NoiseHandshakeOptions {
  readonly remoteStaticPublicKey: Uint8Array;
}

type Role = 'initiator' | 'responder';

/**
 * One IK handshake. Exactly two messages: the initiator writes then reads, the
 * responder reads then writes. Any failure is terminal — the object refuses
 * every later call rather than letting a caller retry on half-mixed state.
 */
export class NoiseHandshake {
  readonly #role: Role;
  readonly #crypto: WebCryptoLike;
  readonly #symmetric: SymmetricState;
  readonly #static: NoiseKeyPair;
  /** Injected `e` up front, else the generated one from the message this role writes. */
  #ephemeral: NoiseKeyPair | undefined;
  #remoteStatic: Uint8Array | undefined;
  #remoteEphemeral: Uint8Array | undefined;
  #firstMessageDone = false;
  #failed = false;
  /** True from the first line of {@link NoiseHandshake.#step} to its last. */
  #inFlight = false;
  #session: NoiseSession | undefined;

  private constructor(
    crypto: WebCryptoLike,
    symmetric: SymmetricState,
    options: NoiseHandshakeOptions,
    remoteStatic: Uint8Array | undefined,
  ) {
    // In IK the initiator is exactly the side that knows `rs` before speaking,
    // so deriving the role makes a role/`rs` mismatch unrepresentable — and
    // `#writeMessage1`'s `#remoteStatic!` sound.
    this.#role = remoteStatic === undefined ? 'responder' : 'initiator';
    this.#crypto = crypto;
    this.#symmetric = symmetric;
    this.#static = options.staticKeyPair;
    this.#ephemeral = options.ephemeralKeyPair;
    this.#remoteStatic = remoteStatic;
  }

  /**
   * Shared by {@link createNoiseInitiator} and {@link createNoiseResponder}.
   * Passing `rs` starts an initiator, omitting it a responder; every key this
   * handshake will ever use is length-checked here, so no caller can reach the
   * private constructor with an unvalidated one.
   */
  static async start(
    options: NoiseHandshakeOptions,
    remoteStatic: Uint8Array | undefined,
  ): Promise<NoiseHandshake> {
    const crypto = options.crypto ?? getWebCrypto();
    requireKey(options.staticKeyPair.publicKey, 'local static public key');
    if (options.ephemeralKeyPair !== undefined) {
      requireKey(options.ephemeralKeyPair.publicKey, 'ephemeral public key');
    }
    if (remoteStatic !== undefined) requireKey(remoteStatic, 'remote static public key');
    const symmetric = SymmetricState.initialize(crypto);
    await symmetric.mixHash(options.prologue);
    // Pre-message `<- s`: both sides mix the responder's static public key —
    // `rs` for the initiator, its own `s` for the responder.
    await symmetric.mixHash(remoteStatic ?? options.staticKeyPair.publicKey);
    return new NoiseHandshake(crypto, symmetric, options, remoteStatic);
  }

  /** Whether both messages have been processed and `session` is available. */
  get isComplete(): boolean {
    return this.#session !== undefined;
  }

  /** The peer's static public key: known up front by the initiator, learned in message 1 by the responder. */
  get remoteStaticPublicKey(): Uint8Array | undefined {
    // Copied: the responder still owes an `se` DH against these bytes.
    return this.#remoteStatic === undefined ? undefined : copyKey(this.#remoteStatic, 0);
  }

  /** The `Split` result. Throws until the handshake completes. */
  get session(): NoiseSession {
    if (this.#session === undefined) throw new NoiseError('handshake is not complete');
    return this.#session;
  }

  async writeMessage(payload: Uint8Array = EMPTY): Promise<Uint8Array> {
    return await this.#step(async () => {
      if (this.#role === 'initiator') {
        if (this.#firstMessageDone) throw new NoiseError('the initiator writes only message 1');
        return await this.#writeMessage1(payload);
      }
      if (!this.#firstMessageDone) throw new NoiseError('the responder writes only message 2');
      return await this.#writeMessage2(payload);
    });
  }

  async readMessage(message: Uint8Array): Promise<Uint8Array> {
    return await this.#step(async () => {
      if (this.#role === 'responder') {
        if (this.#firstMessageDone) throw new NoiseError('the responder reads only message 1');
        return await this.#readMessage1(message);
      }
      if (!this.#firstMessageDone) throw new NoiseError('the initiator reads only message 2');
      return await this.#readMessage2(message);
    });
  }

  /**
   * Run one handshake message, at most one at a time.
   *
   * **A second call while one is in flight fails the handshake**, rather than
   * queueing behind it. A step is a dozen awaited WebCrypto calls that mutate
   * the symmetric state in order; two interleaved would mix the same key twice
   * or read `h` between two of its writes, producing a transcript neither peer
   * can reproduce. The message-order guards above cannot see that, because they
   * read `#firstMessageDone` — which the step sets at its *end*. Failing is the
   * whole recovery: a caller reaching here has a bug, and the handshake is
   * cheap to redo but impossible to resynchronize.
   */
  async #step(run: () => Promise<Uint8Array>): Promise<Uint8Array> {
    if (this.#failed) throw new NoiseError('handshake already failed');
    if (this.#session !== undefined) throw new NoiseError('handshake already complete');
    if (this.#inFlight) {
      this.#failed = true;
      throw new NoiseError('handshake step is already in flight');
    }
    this.#inFlight = true;
    try {
      return await run();
    } catch (error) {
      this.#failed = true;
      throw error instanceof NoiseError ? error : new NoiseError('handshake failed');
    } finally {
      this.#inFlight = false;
    }
  }

  /** `-> e, es, s, ss` */
  async #writeMessage1(payload: Uint8Array): Promise<Uint8Array> {
    requireMessageLength(MESSAGE_1_OVERHEAD + payload.length, 1);
    const ephemeral = await this.#useEphemeral();
    await this.#symmetric.mixHash(ephemeral.publicKey);
    await this.#symmetric.mixKey(await this.#dh(ephemeral.privateKey, this.#remoteStatic!));
    const encryptedStatic = await this.#symmetric.encryptAndHash(this.#static.publicKey);
    await this.#symmetric.mixKey(await this.#dh(this.#static.privateKey, this.#remoteStatic!));
    const encryptedPayload = await this.#symmetric.encryptAndHash(payload);
    this.#firstMessageDone = true;
    return concatBytes(ephemeral.publicKey, encryptedStatic, encryptedPayload);
  }

  /** `-> e, es, s, ss` */
  async #readMessage1(message: Uint8Array): Promise<Uint8Array> {
    requireMessageLength(message.length, 1);
    const staticEnd = MESSAGE_1_OVERHEAD - NOISE_TAG_LENGTH;
    const remoteEphemeral = copyKey(message, 0);
    this.#remoteEphemeral = remoteEphemeral;
    await this.#symmetric.mixHash(remoteEphemeral);
    await this.#symmetric.mixKey(await this.#dh(this.#static.privateKey, remoteEphemeral));
    const remoteStatic = await this.#symmetric.decryptAndHash(
      message.subarray(NOISE_KEY_LENGTH, staticEnd),
    );
    requireKey(remoteStatic, 'remote static public key');
    this.#remoteStatic = remoteStatic;
    await this.#symmetric.mixKey(await this.#dh(this.#static.privateKey, remoteStatic));
    const payload = await this.#symmetric.decryptAndHash(message.subarray(staticEnd));
    this.#firstMessageDone = true;
    return payload;
  }

  /** `<- e, ee, se` */
  async #writeMessage2(payload: Uint8Array): Promise<Uint8Array> {
    requireMessageLength(MESSAGE_2_OVERHEAD + payload.length, 2);
    const ephemeral = await this.#useEphemeral();
    await this.#symmetric.mixHash(ephemeral.publicKey);
    await this.#symmetric.mixKey(await this.#dh(ephemeral.privateKey, this.#remoteEphemeral!));
    await this.#symmetric.mixKey(await this.#dh(ephemeral.privateKey, this.#remoteStatic!));
    const encryptedPayload = await this.#symmetric.encryptAndHash(payload);
    this.#session = await this.#split();
    return concatBytes(ephemeral.publicKey, encryptedPayload);
  }

  /** `<- e, ee, se` */
  async #readMessage2(message: Uint8Array): Promise<Uint8Array> {
    requireMessageLength(message.length, 2);
    const remoteEphemeral = copyKey(message, 0);
    await this.#symmetric.mixHash(remoteEphemeral);
    await this.#symmetric.mixKey(await this.#dh(this.#ephemeral!.privateKey, remoteEphemeral));
    await this.#symmetric.mixKey(await this.#dh(this.#static.privateKey, remoteEphemeral));
    const payload = await this.#symmetric.decryptAndHash(message.subarray(NOISE_KEY_LENGTH));
    this.#session = await this.#split();
    return payload;
  }

  async #split(): Promise<NoiseSession> {
    return await this.#symmetric.split(this.#role === 'initiator');
  }

  async #useEphemeral(): Promise<NoiseKeyPair> {
    this.#ephemeral ??= await generateNoiseKeyPair(this.#crypto);
    return this.#ephemeral;
  }

  #dh(privateKey: CryptoKeyLike, publicKey: Uint8Array): Promise<Uint8Array> {
    return x25519Agree(this.#crypto, privateKey, publicKey);
  }
}

/**
 * X25519 to a raw shared secret. A rejected key, a rejected agreement, and an
 * all-zero result are one indistinguishable terminal failure — a peer that
 * presented a low-order point is one whose "shared" secret every other peer can
 * compute too.
 *
 * Exported because the sealed push runs the same agreement under a different
 * key schedule (`push-seal.ts`); one implementation is what keeps the two from
 * disagreeing about which points are usable.
 */
export async function x25519Agree(
  crypto: WebCryptoLike,
  privateKey: CryptoKeyLike,
  publicKey: Uint8Array,
): Promise<Uint8Array> {
  requireKey(publicKey, 'X25519 public key');
  let shared: Uint8Array;
  try {
    const imported = await crypto.subtle.importKey('raw', publicKey, X25519_ALGORITHM, false, []);
    shared = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'X25519', public: imported },
        privateKey,
        NOISE_KEY_LENGTH * 8,
      ),
    );
  } catch {
    throw new NoiseError('X25519 agreement failed');
  }
  if (shared.length !== NOISE_KEY_LENGTH || constantTimeEqual(shared, ZERO_KEY)) {
    throw new NoiseError('X25519 agreement failed');
  }
  return shared;
}

function requireKey(key: Uint8Array, what: string): void {
  if (key.length !== NOISE_KEY_LENGTH) throw new NoiseError(`${what} must be 32 bytes`);
}

/**
 * The 32 bytes at `offset`, always copied. Never `.slice()`: Node aliases
 * `Buffer.prototype.slice` to `subarray`, so a `Buffer` argument — what a
 * Node host gets from a WebSocket frame — would hand back a live view that
 * changes under us if the caller reuses its read buffer.
 */
function copyKey(source: Uint8Array, offset: number): Uint8Array {
  return new Uint8Array(source.subarray(offset, offset + NOISE_KEY_LENGTH));
}

/** Noise's cap, which applies to every message — handshake and transport alike. */
function requireMaxMessageLength(length: number): void {
  if (length > NOISE_MAX_MESSAGE_LENGTH) {
    throw new NoiseError('message exceeds the Noise maximum');
  }
}

/** Both ends of one handshake message's length contract. */
function requireMessageLength(length: number, message: 1 | 2): void {
  const overhead = message === 1 ? MESSAGE_1_OVERHEAD : MESSAGE_2_OVERHEAD;
  if (length < overhead) throw new NoiseError(`handshake message ${message} is too short`);
  requireMaxMessageLength(length);
}

/** Start the IK initiator: it holds `rs` up front and writes message 1. */
export async function createNoiseInitiator(
  options: NoiseInitiatorOptions,
): Promise<NoiseHandshake> {
  // Length-checked before the copy: `copyKey` truncates, so validating the
  // copy would silently accept an over-long key as its first 32 bytes.
  requireKey(options.remoteStaticPublicKey, 'remote static public key');
  return await NoiseHandshake.start(options, copyKey(options.remoteStaticPublicKey, 0));
}

/** Start the IK responder: it learns `rs` from message 1 and writes message 2. */
export async function createNoiseResponder(
  options: NoiseHandshakeOptions,
): Promise<NoiseHandshake> {
  return await NoiseHandshake.start(options, undefined);
}
