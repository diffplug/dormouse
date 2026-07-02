/**
 * Minimal structural typings for the WebCrypto API.
 *
 * This package compiles with `"lib": ["ES2022"]` and `"types": []` so it can
 * ship to both the browser (`lib`) and Node (`server`) without pulling in DOM
 * or Node type definitions. Both runtimes expose the same WebCrypto
 * implementation on `globalThis.crypto`; the interfaces here describe just the
 * slice of it that the security primitives use, and real `CryptoKey` /
 * `SubtleCrypto` objects satisfy them structurally.
 */

export interface CryptoKeyLike {
  readonly type: 'public' | 'private' | 'secret';
  readonly extractable: boolean;
  readonly algorithm: object;
  readonly usages: readonly string[];
}

export interface CryptoKeyPairLike {
  readonly publicKey: CryptoKeyLike;
  readonly privateKey: CryptoKeyLike;
}

/** The subset of `SubtleCrypto` used by this package (asymmetric keys only). */
export interface SubtleCryptoLike {
  generateKey(
    algorithm: object,
    extractable: boolean,
    keyUsages: readonly string[],
  ): Promise<CryptoKeyPairLike>;
  exportKey(format: string, key: CryptoKeyLike): Promise<ArrayBuffer>;
  importKey(
    format: string,
    keyData: Uint8Array,
    algorithm: object,
    extractable: boolean,
    keyUsages: readonly string[],
  ): Promise<CryptoKeyLike>;
  sign(algorithm: object, key: CryptoKeyLike, data: Uint8Array): Promise<ArrayBuffer>;
  verify(
    algorithm: object,
    key: CryptoKeyLike,
    signature: Uint8Array,
    data: Uint8Array,
  ): Promise<boolean>;
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
}

export interface WebCryptoLike {
  readonly subtle: SubtleCryptoLike;
  getRandomValues<T extends Uint8Array>(array: T): T;
}

/**
 * The runtime's WebCrypto implementation. Every crypto-touching function in
 * this package takes an optional `crypto` parameter defaulting to this, so
 * tests can inject fakes and exotic runtimes can supply their own.
 */
export function getWebCrypto(): WebCryptoLike {
  const crypto = (globalThis as { crypto?: WebCryptoLike }).crypto;
  if (!crypto || !crypto.subtle) {
    throw new Error(
      'WebCrypto is unavailable: globalThis.crypto.subtle is required ' +
        '(all modern browsers and Node >= 20 provide it)',
    );
  }
  return crypto;
}
