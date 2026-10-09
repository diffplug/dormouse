/** The width the Markdown editor shows an image at when its document gives it
 * no size: its upright pixel width over the scale its header records
 * (docs/specs/dor-tools-builtin.md -> Markdown editor). Read from the head of
 * the file, without decoding it. Browser-safe. */
import { exifFields, jpegSegments, jpegSize, pngChunks, pngSize } from './image-editability.js';
import { ascii } from './image-format.js';

/** How much of a file's head `defaultDisplayWidth` reads: a PNG's `pHYs` and
 * `eXIf` precede its image data, and a screenshot's header is a few KiB; a
 * JPEG whose frame header sits behind more EXIF or ICC than this shows pixel
 * for pixel. */
export const RESOLUTION_HEAD = 1 << 16;

/** A PNG's or JPEG's upright pixel width and the dots per inch its header
 * records: a PNG's `pHYs` in pixels per metre, else its `eXIf`; a JPEG's JFIF
 * density in dots per inch or centimetre, else its EXIF. Null without a frame
 * size in `head`. */
export function imageResolution(head: Uint8Array): { width: number; dpi: number | null } | null {
  const png = pngSize(head), size = png ?? jpegSize(head);
  if (!size) return null;
  let dpi: number | null = null, exif: Uint8Array | null = null;
  if (png) {
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    for (const { type, start, end } of pngChunks(head)) {
      // pHYs: pixels per unit across, down, then the unit, where 1 is the metre.
      if (type === 'pHYs' && end - start === 21 && head[start + 16] === 1) dpi = view.getUint32(start + 8) * 0.0254;
      if (type === 'eXIf') exif = head.subarray(start + 8, end - 4);
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
