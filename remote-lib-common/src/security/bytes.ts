/**
 * Byte-level helpers shared by the security primitives.
 *
 * UTF-8 uses the platform Encoding API; `globals.d.ts` declares its narrow
 * surface without importing DOM or Node types. Base64url stays strict about
 * alphabet and trailing bits across every runtime.
 */

const B64U_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const B64U_REVERSE: Int16Array = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64U_ALPHABET.length; i++) {
    table[B64U_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

/** Encode bytes as unpadded base64url. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : undefined;
    out += B64U_ALPHABET[b0 >> 2]!;
    out += B64U_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]!;
    if (b1 !== undefined) out += B64U_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]!;
    if (b2 !== undefined) out += B64U_ALPHABET[b2 & 0x3f]!;
  }
  return out;
}

/**
 * A non-empty base64url string no longer than `limit` — the shape of every
 * handle, id, and ciphertext on this wire. Length first, alphabet second: the
 * scan is the expensive half, so a bound rejects before it runs.
 *
 * Padding is rejected even though {@link fromBase64Url} tolerates it, so a
 * given byte string has exactly one accepted spelling on the wire.
 */
export function isBoundedBase64Url(value: unknown, limit: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= limit &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

/**
 * Base64url of exactly `length` *characters* — canonical, unpadded, and one
 * fixed size. Every fixed-width handle in this package (a routing id, a delivery
 * id, an ACL key) is checked with this rather than with a bound, so a value of
 * any other length is refused before it becomes a map key.
 */
export function isExactBase64Url(value: unknown, length: number): value is string {
  return isBoundedBase64Url(value, length) && value.length === length;
}

/** Unpadded base64url characters for `byteLength` bytes. */
export function base64UrlLength(byteLength: number): number {
  const remainder = byteLength % 3;
  return Math.floor(byteLength / 3) * 4 + (remainder === 0 ? 0 : remainder + 1);
}

/**
 * Decode base64url. Trailing `=` padding is tolerated; anything else invalid
 * (bad characters, impossible length, nonzero trailing bits) throws, so a
 * given byte string has exactly one accepted encoding.
 */
export function fromBase64Url(text: string): Uint8Array {
  let end = text.length;
  while (end > 0 && text[end - 1] === '=') end--;
  const rem = end % 4;
  if (rem === 1) throw new Error('invalid base64url: impossible length');
  const outLength = (end >> 2) * 3 + (rem === 0 ? 0 : rem - 1);
  const out = new Uint8Array(outLength);
  let bits = 0;
  let bitCount = 0;
  let outIndex = 0;
  for (let i = 0; i < end; i++) {
    const code = text.charCodeAt(i);
    const value = code < 128 ? B64U_REVERSE[code]! : -1;
    if (value < 0) throw new Error(`invalid base64url character at index ${i}`);
    bits = (bits << 6) | value;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      out[outIndex++] = (bits >> bitCount) & 0xff;
    }
  }
  if ((bits & ((1 << bitCount) - 1)) !== 0) {
    throw new Error('invalid base64url: nonzero trailing bits');
  }
  return out;
}

const utf8Encoder = new TextEncoder();
// Fatal decoding never silently changes authenticated text. `ignoreBOM` keeps
// U+FEFF as content, including at the start of each independent terminal chunk.
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Encode UTF-8, replacing unpaired UTF-16 surrogates with U+FFFD. */
export function utf8Encode(text: string): Uint8Array {
  return utf8Encoder.encode(text);
}

/** Decode one complete UTF-8 value; reject malformed sequences. */
export function utf8Decode(bytes: Uint8Array): string {
  return utf8Decoder.decode(bytes);
}

/** Concatenate byte arrays. */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Concatenate byte arrays with a 4-byte big-endian length before each part.
 * Used to build signing payloads: unlike plain concatenation, the framing
 * makes the field boundaries part of the signed bytes, so
 * `["ab","c"]` and `["a","bc"]` can never collide.
 */
export function lengthPrefixedConcat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += UINT32_SIZE + part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    writeUint32BE(out, offset, part.length);
    out.set(part, offset + UINT32_SIZE);
    offset += UINT32_SIZE + part.length;
  }
  return out;
}

/** Bytes in the big-endian `u32` every length prefix in this system uses. */
export const UINT32_SIZE = 4;

/** Write `value` as big-endian `u32` at `offset`; the caller sizes `out`. */
export function writeUint32BE(out: Uint8Array, offset: number, value: number): void {
  out[offset] = (value >>> 24) & 0xff;
  out[offset + 1] = (value >>> 16) & 0xff;
  out[offset + 2] = (value >>> 8) & 0xff;
  out[offset + 3] = value & 0xff;
}

/** Read the big-endian `u32` at `offset`, unsigned. */
export function readUint32BE(bytes: Uint8Array, offset = 0): number {
  return (
    ((bytes[offset]! << 24) >>> 0) +
    (bytes[offset + 1]! << 16) +
    (bytes[offset + 2]! << 8) +
    bytes[offset + 3]!
  );
}

/**
 * A string no longer than `limit` — what a wire guard actually wants, since a
 * type check alone bounds nothing: a megabyte string is a `string`. The limit
 * is the caller's, because what a pairing field may cost is not what a
 * presence binding may cost.
 */
export function isBoundedString(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length <= limit;
}

/** Compare byte arrays without early exit on the first mismatching byte. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}
