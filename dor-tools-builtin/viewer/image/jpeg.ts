/** JPEG color profiles across a re-encode: the source's APP2 `ICC_PROFILE`
 * segments, spliced into the bytes a canvas encodes. No DOM, so Node tests load it. */

type Bytes = Uint8Array<ArrayBuffer>;
const ICC = 'ICC_PROFILE\0';

interface Segment { marker: number; start: number; end: number }

/** `bytes`' marker segments from SOI up to the scan, which `rest` starts. */
function segments(bytes: Uint8Array): { list: Segment[]; rest: number } {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Not a JPEG.');
  const list: Segment[] = [];
  for (let at = 2; ;) {
    if (at + 4 > bytes.length || bytes[at] !== 0xff) throw new Error('The JPEG is corrupt.');
    const marker = bytes[at + 1];
    if (marker === 0xff) { at++; continue; }
    if (marker === 0xda || marker === 0xd9) return { list, rest: at };
    const end = at + 2 + ((bytes[at + 2] << 8) | bytes[at + 3]);
    if (end > bytes.length) throw new Error('The JPEG ends early.');
    list.push({ marker, start: at, end });
    at = end;
  }
}

const isIcc = (bytes: Uint8Array, s: Segment) =>
  s.marker === 0xe2 && String.fromCharCode(...bytes.subarray(s.start + 4, s.start + 4 + ICC.length)) === ICC;

/** The APP2 `ICC_PROFILE` segments of a JPEG, whole and in order. */
export function iccSegments(bytes: Uint8Array): Uint8Array[] {
  return segments(bytes).list.filter(s => isIcc(bytes, s)).map(s => bytes.slice(s.start, s.end));
}

/** The profile `iccSegments` carry, rejoined by their sequence numbers. */
export function iccProfile(icc: readonly Uint8Array[]): Uint8Array | null {
  if (!icc.length) return null;
  const parts = [...icc].sort((a, b) => a[4 + ICC.length] - b[4 + ICC.length]).map(s => s.subarray(4 + ICC.length + 2));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => { out.set(p, at); return at + p.length; }, 0);
  return out;
}

/** `encoded` with its own ICC segments replaced by `icc`, placed after SOI and
 * the JFIF APP0 header that follows it, when there is one. */
export function spliceIcc(encoded: Uint8Array, icc: readonly Uint8Array[]): Bytes {
  const { list, rest } = segments(encoded);
  const head = list[0]?.marker === 0xe0 ? [list[0]] : [];
  const parts = [encoded.subarray(0, 2), ...head.map(s => encoded.subarray(s.start, s.end)), ...icc,
    ...list.slice(head.length).filter(s => !isIcc(encoded, s)).map(s => encoded.subarray(s.start, s.end)), encoded.subarray(rest)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => { out.set(p, at); return at + p.length; }, 0);
  return out;
}
