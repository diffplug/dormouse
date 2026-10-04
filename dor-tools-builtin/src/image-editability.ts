/** Whether the image editor opens a PNG or JPEG, decided from its size and
 * the header at its head without decoding it (docs/specs/dor-tools-builtin.md
 * -> Image editor). Every host and the editor page ask this one function.
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
 * view-only. A header it cannot read counts as editable; the decoder then says
 * what is wrong. */
export function imageEditability(size: number, head: Uint8Array): Editability {
  if (size > IMAGE_BOUND.limit) return { viewOnly: `View only: this image is past the editor's ${IMAGE_BOUND.limit >> 20} MiB limit.` };
  const frame = pngSize(head) ?? jpegSize(head);
  if (frame && frame.width * frame.height > MAX_EDIT_PIXELS) {
    return { viewOnly: `View only: at ${frame.width} × ${frame.height} pixels, this image is past the editor's ${MAX_EDIT_PIXELS >> 20}-megapixel limit.` };
  }
  return { ok: true };
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
