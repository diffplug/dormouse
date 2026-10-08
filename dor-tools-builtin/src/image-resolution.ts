/** The width the Markdown editor shows an image at when its document gives it
 * no size: its upright pixel width over the scale its header records
 * (docs/specs/dor-tools-builtin.md -> Markdown editor). Read from the head of
 * the file, without decoding it. Browser-safe. */
import { jpegSegments, jpegSize, pngSize } from './image-editability.js';
import { ascii, isPng } from './image-format.js';

/** How much of a file's head `defaultDisplayWidth` reads: a PNG's `pHYs` and
 * `eXIf` precede its image data, and a screenshot's header is a few KiB; a
 * JPEG whose frame header sits behind more EXIF or ICC than this shows pixel
 * for pixel. */
export const RESOLUTION_HEAD = 1 << 16;

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

/** A PNG's or JPEG's upright pixel width and the dots per inch its header
 * records: a PNG's `pHYs` in pixels per metre, else its `eXIf`; a JPEG's JFIF
 * density in dots per inch or centimetre, else its EXIF. Null without a frame
 * size in `head`. */
export function imageResolution(head: Uint8Array): { width: number; dpi: number | null } | null {
  const size = pngSize(head) ?? jpegSize(head);
  if (!size) return null;
  let dpi: number | null = null, exif: Uint8Array | null = null;
  if (isPng(head)) {
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    for (let at = 8; at + 8 <= head.length;) {
      const length = view.getUint32(at), type = ascii(head, at + 4, at + 8);
      if (at + 12 + length > head.length) break;
      // pHYs: pixels per unit across, down, then the unit, where 1 is the metre.
      if (type === 'pHYs' && length === 9 && head[at + 16] === 1) dpi = view.getUint32(at + 8) * 0.0254;
      if (type === 'eXIf') exif = head.subarray(at + 8, at + 8 + length);
      at += 12 + length;
    }
  } else {
    for (const { marker, start, end } of jpegSegments(head).list) {
      // JFIF: "JFIF\0", its version, then units (1 dpi, 2 dpcm) and the density across.
      if (marker === 0xe0 && end - start >= 16 && ascii(head, start + 4, start + 9) === 'JFIF\0') {
        const units = head[start + 11], density = (head[start + 12] << 8) | head[start + 13];
        if (density && (units === 1 || units === 2)) dpi = units === 1 ? density : density * 2.54;
      }
      if (marker === 0xe1 && ascii(head, start + 4, start + 10) === 'Exif\0\0') exif = head.subarray(start + 10, end);
    }
  }
  const fields = exif ? exifFields(exif) : { orientation: 1, dpi: null };
  // Orientations 5–8 turn the image a quarter, so it shows as tall as its frame is wide.
  return { width: fields.orientation >= 5 ? size.height : size.width, dpi: dpi ?? fields.dpi };
}

/** How many of an image's pixels make one CSS pixel, by the `dpi` its file
 * records. Two baselines record a 1× pixel: 72 dpi, the macOS point (a Retina
 * screenshot records 144, or 216 at 3×), and 96 dpi, Windows' 100% scale (192
 * at 200%). A whole multiple of 72, else of 96, from twice up, is that scale,
 * within 1 dpi since pixels per metre round. Anything else — none, 72, 96, or
 * a print resolution such as 150 or 300 — is 1, pixel for pixel. */
export function displayScale(dpi: number | null): number {
  if (dpi === null) return 1;
  for (const baseline of [72, 96]) {
    const scale = Math.round(dpi / baseline);
    if (scale >= 2 && Math.abs(dpi - scale * baseline) <= 1) return scale;
  }
  return 1;
}

/** The CSS width an image whose file starts with `head` shows at when its
 * document gives no size; null when it shows pixel for pixel. */
export function defaultDisplayWidth(head: Uint8Array): number | null {
  const found = imageResolution(head);
  const scale = found ? displayScale(found.dpi) : 1;
  return found && scale > 1 ? found.width / scale : null;
}
