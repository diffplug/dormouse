/** The sizes the Markdown editor writes into its document for an image
 * (docs/specs/dor-tools-builtin.md -> Markdown editor): a pasted one's width,
 * its upright pixel width over the scale its header records, read without
 * decoding it. Browser-safe. */
import { exifFields, jpegSegments, jpegSize, pngChunks, pngSize } from './image-editability.js';
import { ascii } from './image-format.js';

/** The pixel density an image file records, for its pixels upright: pixels
 * per metre across (`x`) and down (`y`), or, when `aspectOnly` (a PNG `pHYs`
 * in unit 0, a JFIF density in units 0), only their ratio. */
export interface Resolution { x: number; y: number; aspectOnly: boolean }

const INCH = 0.0254;

/** The dots per inch `resolution` records across; null for an aspect only. */
export const dpiAcross = (resolution: Resolution | null | undefined): number | null =>
  resolution && !resolution.aspectOnly ? resolution.x * INCH : null;

/** A PNG's or JPEG's upright pixel width and the resolution its header
 * records: a PNG's `pHYs`, a JPEG's JFIF density in dots per inch or
 * centimetre, else its EXIF's across, down by the aspect a unitless record
 * gives. Null without a frame size in `head`. */
export function imageResolution(head: Uint8Array): { width: number; resolution: Resolution | null } | null {
  const png = pngSize(head), size = png ?? jpegSize(head);
  if (!size) return null;
  let own: Resolution | null = null, exif: Uint8Array | null = null;
  if (png) {
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    for (const { type, start, end } of pngChunks(head)) {
      // pHYs: pixels per unit across, down, then the unit: 1 the metre, 0 none.
      if (type === 'pHYs' && end - start === 21 && head[start + 16] <= 1) {
        own = density(view.getUint32(start + 8), view.getUint32(start + 12), head[start + 16] ? 1 : null);
      }
      if (type === 'eXIf') exif = head.subarray(start + 8, end - 4);
    }
  } else {
    for (const { marker, start, end } of jpegSegments(head).list) {
      // JFIF: "JFIF\0", its version, then units (0 none, 1 dpi, 2 dpcm) and the density across and down.
      if (marker === 0xe0 && end - start >= 16 && ascii(head, start + 4, start + 9) === 'JFIF\0' && head[start + 11] <= 2) {
        const units = head[start + 11];
        own = density((head[start + 12] << 8) | head[start + 13], (head[start + 14] << 8) | head[start + 15], units ? (units === 1 ? 1 / INCH : 100) : null);
      }
      if (marker === 0xe1 && ascii(head, start + 4, start + 10) === 'Exif\0\0') exif = head.subarray(start + 10, end);
    }
  }
  const fields = exif ? exifFields(exif) : { orientation: 1, dpi: null };
  let resolution = own;
  if ((!own || own.aspectOnly) && fields.dpi) {
    const x = fields.dpi / INCH;
    resolution = { x, y: own ? x * own.y / own.x : x, aspectOnly: false };
  }
  // Orientations 5–8 turn the image a quarter, so it shows as tall as its frame
  // is wide, its density across the frame's down.
  const turned = fields.orientation >= 5;
  if (turned && resolution) resolution = { ...resolution, x: resolution.y, y: resolution.x };
  return { width: turned ? size.height : size.width, resolution };
}

/** A density of `x` across and `y` down, per metre by `perMetre` units, or
 * an aspect only when it is null; none when either is zero. */
function density(x: number, y: number, perMetre: number | null): Resolution | null {
  if (!x || !y) return null;
  return perMetre ? { x: x * perMetre, y: y * perMetre, aspectOnly: false } : { x, y, aspectOnly: true };
}

/** How many of an image's pixels make one CSS pixel, by the `dpi` its file
 * records. Two baselines record a 1× pixel: 72 dpi, the macOS point, whose
 * only scales are a Retina screenshot's 144 (2×) and 216 (3×), and 96 dpi,
 * Windows' 100% scale, at any whole multiple from twice up (192 at 200%, 288
 * at 300%), within 1 dpi since pixels per metre round. Anything else — none,
 * 72, 96, or a print resolution such as 150 or 300 — is 1, pixel for pixel. */
export function displayScale(dpi: number | null): number {
  if (dpi === null) return 1;
  /** The whole multiple of `baseline` that `dpi` is, else 0. */
  const multiple = (baseline: number) => {
    const scale = Math.round(dpi / baseline);
    return Math.abs(dpi - scale * baseline) <= 1 ? scale : 0;
  };
  const mac = multiple(72), windows = multiple(96);
  return mac === 2 || mac === 3 ? mac : Math.max(windows, 1);
}

/** The CSS width, in whole pixels, a document gives the image file `bytes`
 * as it is pasted; null when it shows pixel for pixel. */
export function defaultDisplayWidth(bytes: Uint8Array): number | null {
  const found = imageResolution(bytes);
  const scale = found ? displayScale(dpiAcross(found.resolution)) : 1;
  return found && scale > 1 ? Math.round(found.width / scale) : null;
}
