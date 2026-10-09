/** Whether the image editor opens a PNG or JPEG, decided from its size and
 * the header at its head without decoding it (docs/specs/dor-tools-builtin.md
 * -> Image editor). Every host and the editor page ask this one function.
 * Also the PNG, JPEG, and EXIF header readers it and the image codecs share.
 * Browser-safe. */
import { ascii, IMAGE_BOUND, isJpeg, isPng } from './image-format.js';

/** The most pixels the editor decodes: 8192 × 8192, a 256 MiB RGBA raster.
 * Editing holds several copies (the raster, the canvas showing it, a save's
 * encode, an undo step), so about 1 GiB at this bound, within what a browser
 * tab is allowed; a 20000 × 20000 image would need 1.6 GB per copy. A
 * 61-megapixel camera photo and an 8K screenshot fit under it. */
export const MAX_EDIT_PIXELS = 1 << 26;

/** How much of a file's head `imageEditability` needs: a JPEG's frame header
 * may sit behind large EXIF or ICC segments. */
export const EDITABILITY_HEAD = 1 << 20;

export type Editability = { ok: true } | { viewOnly: string };

/** Whether the editor opens an image of `size` bytes whose file starts with
 * `head` (its first `EDITABILITY_HEAD` bytes, or more), or why it shows it
 * view-only: past the byte or pixel bound, or a PNG whose `cICP` is HDR or
 * narrow-range. A header it cannot read counts as editable; the decoder then
 * says what is wrong. */
export function imageEditability(size: number, head: Uint8Array): Editability {
  if (size > IMAGE_BOUND.limit) return { viewOnly: `View only: this image is past the editor's ${IMAGE_BOUND.limit >> 20} MiB limit.` };
  const frame = pngSize(head) ?? jpegSize(head);
  if (frame && frame.width * frame.height > MAX_EDIT_PIXELS) {
    return { viewOnly: `View only: at ${frame.width} × ${frame.height} pixels, this image is past the editor's ${MAX_EDIT_PIXELS >> 20}-megapixel limit.` };
  }
  const cicp = pngCicp(head), meaning = cicp ? cicpMeaning(cicp) : null;
  if (meaning?.hdr) return { viewOnly: 'View only: HDR images are view only.' };
  // Narrow-range (video) levels would show washed out, and a swatch would paint past them.
  if (meaning && !meaning.fullRange) return { viewOnly: 'View only: images with narrow-range (video) levels are view only.' };
  return { ok: true };
}

/** cICP transfer characteristics (ITU-T H.273) a canvas shows as SDR: BT.709,
 * BT.601, sRGB, and BT.2020 at 10 and 12 bits. */
const SDR_TRANSFERS = new Set([1, 6, 13, 14, 15]);
/** PQ and HLG: HDR, which no 8-bit canvas edits. */
const HDR_TRANSFERS = new Set([16, 18]);
/** Display P3's color primaries code. */
const P3_PRIMARIES = 12;

/** What a PNG `cICP` chunk's data names, by ITU-T H.273: an HDR or SDR
 * transfer (or neither), full-range levels, and Display P3's primaries. Only
 * full-range SDR shows on a canvas as it means. */
export function cicpMeaning(data: Uint8Array): { hdr: boolean; sdr: boolean; fullRange: boolean; p3: boolean } {
  return { hdr: HDR_TRANSFERS.has(data[1]), sdr: SDR_TRANSFERS.has(data[1]), fullRange: data[3] === 1, p3: data[0] === P3_PRIMARIES };
}

/** The data of the `cICP` chunk in a PNG's `head`; null without one. */
function pngCicp(b: Uint8Array): Uint8Array | null {
  const cicp = pngChunks(b).find(c => c.type === 'cICP');
  return cicp && cicp.end - cicp.start === 16 ? b.subarray(cicp.start + 8, cicp.start + 12) : null;
}

/** One PNG chunk, `bytes[start, end)`: its length, type, data, and CRC. */
export interface PngChunk { type: string; start: number; end: number }

/** A PNG's chunks before its image data (its first IDAT or IEND), which hold
 * its metadata; those before the bytes end mid-chunk, when they do. */
export function pngChunks(bytes: Uint8Array): PngChunk[] {
  const list: PngChunk[] = [];
  if (!isPng(bytes)) return list;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 8; at + 8 <= bytes.length;) {
    const type = ascii(bytes, at + 4, at + 8), end = at + 12 + view.getUint32(at);
    if (type === 'IDAT' || type === 'IEND' || end > bytes.length) break;
    list.push({ type, start: at, end });
    at = end;
  }
  return list;
}

/** The size a PNG's IHDR declares; null without one. */
export function pngSize(b: Uint8Array): { width: number; height: number } | null {
  if (!isPng(b) || b.length < 24 || ascii(b, 12, 16) !== 'IHDR') return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** One JPEG marker segment, `bytes[start, end)`. */
export interface JpegSegment { marker: number; start: number; end: number }

/** A JPEG's marker segments from SOI up to its scan, which `scan` starts;
 * `scan` is null when the bytes end or break first, the segments before
 * that still listed. */
export function jpegSegments(bytes: Uint8Array): { list: JpegSegment[]; scan: number | null } {
  const list: JpegSegment[] = [];
  if (!isJpeg(bytes)) return { list, scan: null };
  for (let at = 2; ;) {
    if (at + 4 > bytes.length || bytes[at] !== 0xff) return { list, scan: null };
    const marker = bytes[at + 1];
    if (marker === 0xff) { at++; continue; }
    if (marker === 0xda || marker === 0xd9) return { list, scan: at };
    const end = at + 2 + ((bytes[at + 2] << 8) | bytes[at + 3]);
    if (end > bytes.length) return { list, scan: null };
    list.push({ marker, start: at, end });
    at = end;
  }
}

/** The frame size a JPEG's SOF header declares; null when `bytes` hold none
 * (or it leaves its height to a later DNL marker). */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  // SOF0–SOF15, less DHT (C4), JPG (C8), and DAC (CC).
  const sof = jpegSegments(bytes).list.find(s => s.marker >= 0xc0 && s.marker <= 0xcf && s.marker !== 0xc4 && s.marker !== 0xc8 && s.marker !== 0xcc);
  if (!sof || sof.end - sof.start < 9) return null;
  const at = sof.start + 5, height = (bytes[at] << 8) | bytes[at + 1], width = (bytes[at + 2] << 8) | bytes[at + 3];
  return width && height ? { width, height } : null;
}

/** What a TIFF-structured EXIF block's first IFD records: its orientation
 * (1–8, else 1) and its horizontal resolution in dots per inch (null without
 * one, or with no absolute unit). */
export function exifFields(tiff: Uint8Array): { orientation: number; dpi: number | null } {
  const fields = { orientation: 1, dpi: null as number | null };
  if (tiff.length < 8) return fields;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return fields;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength), ifd = view.getUint32(4, little);
  if (ifd + 2 > tiff.length) return fields;
  // ResolutionUnit: 2 is the inch (and its default), 3 the centimetre.
  let resolution: number | null = null, unit = 2;
  for (let i = 0, at = ifd + 2, n = view.getUint16(ifd, little); i < n && at + 12 <= tiff.length; i++, at += 12) {
    const tag = view.getUint16(at, little), type = view.getUint16(at + 2, little);
    // Orientation and ResolutionUnit are SHORTs; XResolution a RATIONAL, held at an offset.
    if (tag === 0x0112 && type === 3) {
      const o = view.getUint16(at + 8, little);
      if (o >= 1 && o <= 8) fields.orientation = o;
    } else if (tag === 0x0128 && type === 3) {
      unit = view.getUint16(at + 8, little);
    } else if (tag === 0x011a && type === 5) {
      const offset = view.getUint32(at + 8, little);
      if (offset + 8 <= tiff.length) {
        const numerator = view.getUint32(offset, little), denominator = view.getUint32(offset + 4, little);
        if (numerator && denominator) resolution = numerator / denominator;
      }
    }
  }
  fields.dpi = resolution === null ? null : unit === 2 ? resolution : unit === 3 ? resolution * 2.54 : null;
  return fields;
}
