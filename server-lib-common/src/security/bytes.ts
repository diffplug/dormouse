/**
 * Byte-level helpers shared by the security primitives.
 *
 * Implemented from scratch (no `TextEncoder`, `atob`, or `Buffer`) because
 * this package compiles against the bare ES2022 lib — see `webcrypto.ts` for
 * why. All wire-format values in the security model are base64url strings.
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

/** Encode a string as UTF-8 bytes. */
export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0x7f) {
      out.push(cp);
    } else if (cp <= 0x7ff) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp <= 0xffff) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

/** Decode UTF-8 bytes to a string; throws on structurally invalid sequences. */
export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i]!;
    let cp: number;
    let extra: number;
    if (b0 < 0x80) {
      cp = b0;
      extra = 0;
    } else if ((b0 & 0xe0) === 0xc0) {
      cp = b0 & 0x1f;
      extra = 1;
    } else if ((b0 & 0xf0) === 0xe0) {
      cp = b0 & 0x0f;
      extra = 2;
    } else if ((b0 & 0xf8) === 0xf0) {
      cp = b0 & 0x07;
      extra = 3;
    } else {
      throw new Error(`invalid UTF-8 lead byte at index ${i}`);
    }
    if (i + extra >= bytes.length) throw new Error('truncated UTF-8 sequence');
    for (let j = 1; j <= extra; j++) {
      const b = bytes[i + j]!;
      if ((b & 0xc0) !== 0x80) throw new Error(`invalid UTF-8 continuation byte at index ${i + j}`);
      cp = (cp << 6) | (b & 0x3f);
    }
    if (cp > 0x10ffff) throw new Error(`invalid UTF-8 code point at index ${i}`);
    out += String.fromCodePoint(cp);
    i += extra + 1;
  }
  return out;
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
  for (const part of parts) total += 4 + part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out[offset] = (part.length >>> 24) & 0xff;
    out[offset + 1] = (part.length >>> 16) & 0xff;
    out[offset + 2] = (part.length >>> 8) & 0xff;
    out[offset + 3] = part.length & 0xff;
    out.set(part, offset + 4);
    offset += 4 + part.length;
  }
  return out;
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
