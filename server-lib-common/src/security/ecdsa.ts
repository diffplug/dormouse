/**
 * ECDSA signature format conversion.
 *
 * WebCrypto produces and consumes "raw" ECDSA signatures (`r || s`, fixed
 * width), while WebAuthn authenticators emit ASN.1 DER
 * (`SEQUENCE { INTEGER r, INTEGER s }`). Passkey assertion verification needs
 * DER→raw; the test harness's simulated authenticator needs raw→DER.
 */

const P256_COORDINATE_LENGTH = 32;

/** Convert a raw `r || s` ECDSA signature to ASN.1 DER. */
export function ecdsaRawToDer(raw: Uint8Array): Uint8Array {
  if (raw.length === 0 || raw.length % 2 !== 0) {
    throw new Error(`invalid raw ECDSA signature length ${raw.length}`);
  }
  const half = raw.length / 2;
  const r = derInteger(raw.subarray(0, half));
  const s = derInteger(raw.subarray(half));
  const bodyLength = r.length + s.length;
  if (bodyLength > 127) throw new Error('ECDSA signature too large for short-form DER');
  const out = new Uint8Array(2 + bodyLength);
  out[0] = 0x30;
  out[1] = bodyLength;
  out.set(r, 2);
  out.set(s, 2 + r.length);
  return out;
}

function derInteger(value: Uint8Array): Uint8Array {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start++;
  const trimmed = value.subarray(start);
  // A set high bit would read as a negative INTEGER; prepend a zero byte.
  const pad = trimmed[0]! & 0x80 ? 1 : 0;
  const out = new Uint8Array(2 + pad + trimmed.length);
  out[0] = 0x02;
  out[1] = pad + trimmed.length;
  out.set(trimmed, 2 + pad);
  return out;
}

/**
 * Convert an ASN.1 DER ECDSA signature to raw `r || s` with fixed-width
 * coordinates (P-256 by default). Throws on any structural deviation.
 */
export function ecdsaDerToRaw(
  der: Uint8Array,
  coordinateLength: number = P256_COORDINATE_LENGTH,
): Uint8Array {
  if (der.length < 2 || der[0] !== 0x30) throw new Error('invalid DER: expected SEQUENCE');
  let offset = 1;
  let sequenceLength = der[offset++]!;
  if (sequenceLength === 0x81) {
    sequenceLength = der[offset++]!;
  } else if (sequenceLength > 0x80) {
    throw new Error('invalid DER: unsupported length encoding');
  }
  if (offset + sequenceLength !== der.length) throw new Error('invalid DER: length mismatch');
  const out = new Uint8Array(coordinateLength * 2);
  offset = readDerInteger(der, offset, out.subarray(0, coordinateLength));
  offset = readDerInteger(der, offset, out.subarray(coordinateLength));
  if (offset !== der.length) throw new Error('invalid DER: trailing bytes');
  return out;
}

/** Parse one INTEGER at `offset`, right-align it into `into`, return the next offset. */
function readDerInteger(der: Uint8Array, offset: number, into: Uint8Array): number {
  if (offset + 2 > der.length || der[offset] !== 0x02) {
    throw new Error('invalid DER: expected INTEGER');
  }
  const length = der[offset + 1]!;
  if (length === 0 || length > 0x80) throw new Error('invalid DER: bad INTEGER length');
  const start = offset + 2;
  if (start + length > der.length) throw new Error('invalid DER: truncated INTEGER');
  let valueStart = start;
  while (valueStart < start + length - 1 && der[valueStart] === 0) valueStart++;
  const valueLength = start + length - valueStart;
  if (valueLength > into.length) throw new Error('invalid DER: INTEGER too large');
  into.set(der.subarray(valueStart, start + length), into.length - valueLength);
  return start + length;
}
