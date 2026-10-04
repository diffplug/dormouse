/** Getting pixels in and out of the image editor, and the HTTP shape both
 * image routes share (docs/specs/dor-tools-builtin.md -> Image editor): a GET
 * returns the bytes with their revision in `X-Dor-Version`; a save POSTs the
 * bytes with `?version=` and answers `{version}`. */
import { VERSION_HEADER } from '../../src/image-format';
import { checked, type DocumentSource } from '../document-session';
import { iccSpace } from './icc';
import { iccProfile, iccSegments, jpegSize, spliceIcc } from './jpeg';
import type { Raster } from './pixels';
import { decodePng, encodePng, isPng, pngSize } from './png';

export type EditableMime = 'image/png' | 'image/jpeg';

/** What a save keeps from the file the editor opened. */
export interface ImageFormat {
  mime: EditableMime;
  /** The canvas color space that shows the raw values as the file means them;
   * sRGB also stands in for a profile no canvas offers. */
  colorSpace: PredefinedColorSpace;
  /** The source's color metadata, re-attached verbatim on save: whole PNG
   * chunks, or JPEG APP2 `ICC_PROFILE` segments. */
  keep: readonly Uint8Array[];
}
/** An image file as the editor opens it. */
export interface LoadedImage extends ImageFormat {
  raster: Raster;
  /** Why a save will differ from the source beyond the edits. */
  note?: string;
}

export const SRGB_PNG: ImageFormat = { mime: 'image/png', colorSpace: 'srgb', keep: [] };

/** The most pixels the editor decodes: 8192 × 8192, a 256 MiB RGBA raster.
 * Editing holds several copies (the raster, the canvas showing it, a save's
 * encode, an undo step), so about 1 GiB at this bound, within what a browser
 * tab is allowed; a 20000 × 20000 image would need 1.6 GB per copy. A
 * 61-megapixel camera photo and an 8K screenshot fit under it. */
export const MAX_EDIT_PIXELS = 1 << 26;

/** An image past `MAX_EDIT_PIXELS`, which the editor shows view-only. */
export class TooLargeError extends Error {
  constructor(readonly width: number, readonly height: number) {
    super(`View only: at ${width} × ${height} pixels, this image is past the editor's ${MAX_EDIT_PIXELS / (1 << 20)}-megapixel limit.`);
  }
}

/** Refuses an image whose header declares more than `MAX_EDIT_PIXELS`,
 * before anything decodes it. */
export function checkEditable(bytes: Uint8Array): void {
  let size: { width: number; height: number } | null = null;
  try { size = isPng(bytes) ? pngSize(bytes) : bytes[0] === 0xff && bytes[1] === 0xd8 ? jpegSize(bytes) : null; } catch { /* unreadable: the decoder says why */ }
  if (size && size.width * size.height > MAX_EDIT_PIXELS) throw new TooLargeError(size.width, size.height);
}

/** An image file's pixels: straight (unpremultiplied) RGBA exactly as stored,
 * with its color metadata. PNGs go through the PNG codec; a JPEG, or a PNG the
 * codec refuses, through a canvas, which keeps a JPEG's raw values but may
 * shift a semi-transparent PNG pixel. A JPEG's pixels are turned upright by its
 * EXIF orientation, which a save then drops. Throws `TooLargeError` past
 * `MAX_EDIT_PIXELS`. */
export async function decodeImage(blob: Blob): Promise<LoadedImage> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  checkEditable(bytes);
  if (isPng(bytes)) {
    try {
      const png = await decodePng(bytes);
      return { raster: png.raster, mime: 'image/png', colorSpace: png.space ?? 'srgb', keep: png.keep, note: png.note };
    } catch {
      return { raster: await canvasDecode(blob), ...SRGB_PNG, note: 'Opened with the browser\'s decoder: saving may shift semi-transparent pixels and drops the color profile.' };
    }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let keep: Uint8Array[] = [];
    try { keep = iccSegments(bytes); } catch { /* unreadable segments: decode untagged */ }
    const profile = iccProfile(keep);
    return { raster: await canvasDecode(blob), mime: 'image/jpeg', colorSpace: (profile && iccSpace(profile)) ?? 'srgb', keep };
  }
  return { raster: await canvasDecode(blob), ...SRGB_PNG };
}

/** The page's CSP has no `blob:` images, so this decodes without an `<img>`.
 * The canvas and bitmap both treat the raw values as sRGB, so none convert. */
async function canvasDecode(blob: Blob): Promise<Raster> {
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'from-image' });
  try {
    const { width, height } = bitmap, canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' })!;
    ctx.drawImage(bitmap, 0, 0);
    return { width, height, data: ctx.getImageData(0, 0, width, height, { colorSpace: 'srgb' }).data };
  } finally { bitmap.close(); }
}

/** A copy of `r` with `layer` (straight RGBA of the same size) composited over it.
 * Where the layer is clear the pixels stay exactly; where it is opaque they are its. */
export function over(r: Raster, layer: Uint8ClampedArray): Raster {
  const data = new Uint8ClampedArray(r.data);
  for (let i = 0; i < data.length; i += 4) {
    const sa = layer[i + 3];
    if (!sa) continue;
    const da = (data[i + 3] * (255 - sa)) / 255, oa = sa + da;
    for (let c = i; c < i + 3; c++) data[c] = (layer[c] * sa + data[c] * da) / oa;
    data[i + 3] = oa;
  }
  return { width: r.width, height: r.height, data };
}

/** `r` as a file in `format`. Reads every pixel before it returns, so the
 * caller may change `r` while the bytes are produced. */
export async function encodeImage(r: Raster, format: ImageFormat): Promise<Blob> {
  if (!r.width || !r.height) throw new Error('An empty image cannot be saved.');
  if (format.mime === 'image/png') return new Blob([await encodePng(r, format.keep)], { type: 'image/png' });
  // A JPEG is opaque, so a canvas's premultiplication loses nothing; the
  // sRGB canvas and ImageData pass the raw values through unconverted.
  const canvas = document.createElement('canvas');
  canvas.width = r.width; canvas.height = r.height;
  canvas.getContext('2d', { colorSpace: 'srgb' })!.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.width, r.height, { colorSpace: 'srgb' }), 0, 0);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  if (!blob) throw new Error('This image could not be encoded.');
  return new Blob([spliceIcc(new Uint8Array(await blob.arrayBuffer()), format.keep)], { type: 'image/jpeg' });
}

/** An image document read from the route `load` and written to `save`, under
 * `name`: its bytes, which the editor decodes. */
export const imageSource = (load: string, save: string, name: string): DocumentSource<Blob> => ({
  async load() {
    const response = await checked(await fetch(load, { cache: 'no-store' }));
    return { content: await response.blob(), version: response.headers.get(VERSION_HEADER) ?? '', name };
  },
  async save(blob, version) {
    const response = await checked(await fetch(`${save}?version=${encodeURIComponent(version)}`, {
      method: 'POST', headers: { 'Content-Type': blob.type }, body: blob,
    }));
    return response.json();
  },
});
