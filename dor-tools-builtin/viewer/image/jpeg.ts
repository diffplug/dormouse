/** JPEG color profiles across a re-encode: the source's APP2 `ICC_PROFILE`
 * segments, spliced into the bytes a canvas encodes. No DOM, so Node tests load it. */
import { jpegSegments, type JpegSegment } from '../../src/image-editability';
import { ascii, latin1 } from '../../src/image-format';
import { iccSpace, rgbProfile, type SourceColor } from './icc';

type Bytes = Uint8Array<ArrayBuffer>;
const ICC = 'ICC_PROFILE\0';

/** `bytes`' marker segments up to the scan, which `rest` starts. */
function segments(bytes: Uint8Array): { list: JpegSegment[]; rest: number } {
  const { list, scan } = jpegSegments(bytes);
  if (scan === null) throw new Error('The JPEG is corrupt.');
  return { list, rest: scan };
}

const isIcc = (bytes: Uint8Array, s: JpegSegment) => s.marker === 0xe2 && ascii(bytes, s.start + 4, s.start + 4 + ICC.length) === ICC;

/** The APP2 `ICC_PROFILE` segments of a JPEG, whole and in order. */
export function iccSegments(bytes: Uint8Array): Uint8Array[] {
  return segments(bytes).list.filter(s => isIcc(bytes, s)).map(s => bytes.slice(s.start, s.end));
}

/** A JPEG's color: its ICC segments, kept only when their profile describes
 * RGB. Segments it cannot read leave it untagged. */
export function jpegColor(bytes: Uint8Array): SourceColor {
  let segments: Uint8Array[] = [];
  try { segments = iccSegments(bytes); } catch { /* unreadable segments: decode untagged */ }
  const icc = iccProfile(segments);
  if (!icc) return { space: 'srgb', keep: [], notes: [] };
  const rgb = rgbProfile(icc);
  return 'profile' in rgb ? { space: iccSpace(icc), keep: segments, profile: icc, notes: [] } : { space: 'srgb', keep: [], notes: [rgb.dropped] };
}

/** The profile `iccSegments` carry, rejoined by their sequence numbers. */
export function iccProfile(icc: readonly Uint8Array[]): Uint8Array | null {
  if (!icc.length) return null;
  const parts = [...icc].sort((a, b) => a[4 + ICC.length] - b[4 + ICC.length]).map(s => s.subarray(4 + ICC.length + 2));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => { out.set(p, at); return at + p.length; }, 0);
  return out;
}

/** `profile` as APP2 `ICC_PROFILE` segments, for a save whose source held it
 * some other way: as many as its size needs, numbered from 1; none past the
 * 255 a sequence number counts. */
export function iccSegmentsOf(profile: Uint8Array): Bytes[] {
  // A segment's length field counts itself, the identifier, and the sequence bytes.
  const room = 0xffff - 2 - ICC.length - 2, count = Math.ceil(profile.length / room);
  if (count > 255) return [];
  return Array.from({ length: count }, (_, i) => {
    const part = profile.subarray(i * room, (i + 1) * room), length = 2 + ICC.length + 2 + part.length;
    const out = new Uint8Array(2 + length);
    out.set([0xff, 0xe2, length >> 8, length & 255]);
    out.set(latin1(ICC), 4);
    out.set([i + 1, count], 4 + ICC.length);
    out.set(part, 6 + ICC.length);
    return out;
  });
}

/** `encoded` with its own ICC segments replaced by `icc`, placed after SOI and
 * the JFIF APP0 header that follows it, when there is one: the file's parts, in order. */
export function spliceIcc(encoded: Uint8Array, icc: readonly Uint8Array[]): Bytes[] {
  const { list, rest } = segments(encoded);
  const head = list[0]?.marker === 0xe0 ? [list[0]] : [];
  return [encoded.subarray(0, 2), ...head.map(s => encoded.subarray(s.start, s.end)), ...icc,
    ...list.slice(head.length).filter(s => !isIcc(encoded, s)).map(s => encoded.subarray(s.start, s.end)), encoded.subarray(rest)] as Bytes[];
}
