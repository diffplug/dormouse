/** Getting pixels in and out of the image editor, and the HTTP shape both
 * image routes share (docs/specs/dor-tools-builtin.md -> Image editor): a GET
 * returns the bytes with their revision in `X-Dor-Version`, or JSON naming why
 * the editor shows the image view-only; a save POSTs the bytes with
 * `?version=` and answers `{version}`. */
import { imageEditability } from '../../src/image-editability';
import { isJpeg, isPng, VERSION_HEADER } from '../../src/image-format';
import { checked, type DocumentSource } from '../document-session';
import { iccSpace } from './icc';
import { iccProfile, iccSegments, spliceIcc } from './jpeg';
import type { Raster, Rect } from './pixels';
import { decodePng } from './png';

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
/** An image file as a page loads it: its pixels to edit, or why the editor
 * shows it view-only (`imageEditability`). */
export type ImageLoad = { edit: LoadedImage } | { viewOnly: string };

export const SRGB_PNG: ImageFormat = { mime: 'image/png', colorSpace: 'srgb', keep: [] };

/** An image file's pixels: straight (unpremultiplied) RGBA exactly as stored,
 * with its color metadata. PNGs go through the PNG codec; a JPEG, or a PNG the
 * codec refuses, through a canvas, which keeps a JPEG's raw values but may
 * shift a semi-transparent PNG pixel. A JPEG's pixels are turned upright by its
 * EXIF orientation, which a save then drops. The hosts leave an image past the
 * editor's bounds view-only before it gets here; the check here backs them up. */
export async function decodeImage(blob: Blob): Promise<ImageLoad> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const editability = imageEditability(bytes.length, bytes);
  if ('viewOnly' in editability) return editability;
  if (isPng(bytes)) {
    try {
      const png = await decodePng(bytes);
      return { edit: { raster: png.raster, mime: 'image/png', colorSpace: png.space, keep: png.keep, note: png.note } };
    } catch {
      return { edit: { raster: await canvasDecode(blob), ...SRGB_PNG, note: 'Opened with the browser\'s decoder: saving may shift semi-transparent pixels and drops the color profile.' } };
    }
  }
  if (isJpeg(bytes)) {
    let keep: Uint8Array[] = [];
    try { keep = iccSegments(bytes); } catch { /* unreadable segments: decode untagged */ }
    const profile = iccProfile(keep);
    return { edit: { raster: await canvasDecode(blob), mime: 'image/jpeg', colorSpace: profile ? iccSpace(profile) : 'srgb', keep } };
  }
  return { edit: { raster: await canvasDecode(blob), ...SRGB_PNG } };
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

/** A copy of `r` with `layer` (straight RGBA, `area`'s size) composited over
 * its `area`. Where the layer is clear the pixels stay exactly; where it is
 * opaque they are its. */
export function over(r: Raster, area: Rect, layer: Uint8ClampedArray): Raster {
  const data = new Uint8ClampedArray(r.data);
  for (let y = 0, i = 0; y < area.height; y++) {
    for (let x = 0, o = ((area.y + y) * r.width + area.x) * 4; x < area.width; x++, i += 4, o += 4) {
      const sa = layer[i + 3];
      if (!sa) continue;
      const da = (data[o + 3] * (255 - sa)) / 255, oa = sa + da;
      for (let c = 0; c < 3; c++) data[o + c] = (layer[i + c] * sa + data[o + c] * da) / oa;
      data[o + 3] = oa;
    }
  }
  return { width: r.width, height: r.height, data };
}

/** `r` as a file in `format`. Reads every pixel before it returns, so the
 * caller may change `r` while the bytes are produced; `owned` says no one
 * else holds `r`, which a PNG encode then takes rather than copies. */
export async function encodeImage(r: Raster, format: ImageFormat, owned = false): Promise<Blob> {
  if (!r.width || !r.height) throw new Error('An empty image cannot be saved.');
  if (format.mime === 'image/png') return new Blob(await encodePngOffThread(owned ? r : { ...r, data: r.data.slice() }, format.keep), { type: 'image/png' });
  // A JPEG is opaque, so a canvas's premultiplication loses nothing; the
  // sRGB canvas and ImageData pass the raw values through unconverted.
  const canvas = document.createElement('canvas');
  canvas.width = r.width; canvas.height = r.height;
  canvas.getContext('2d', { colorSpace: 'srgb' })!.putImageData(new ImageData(r.data as Uint8ClampedArray<ArrayBuffer>, r.width, r.height, { colorSpace: 'srgb' }), 0, 0);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  if (!blob) throw new Error('This image could not be encoded.');
  return new Blob(spliceIcc(new Uint8Array(await blob.arrayBuffer()), format.keep), { type: 'image/jpeg' });
}

/** `encodePng` of `r`, which this takes, on a worker of its own. */
function encodePngOffThread(r: Raster, keep: readonly Uint8Array[]): Promise<Uint8Array<ArrayBuffer>[]> {
  const worker = new Worker(new URL('./image.worker.js', import.meta.url), { type: 'module' });
  return new Promise<Uint8Array<ArrayBuffer>[]>((resolve, reject) => {
    worker.onmessage = ({ data }: MessageEvent<{ parts: Uint8Array<ArrayBuffer>[] } | { error: string }>) => {
      if ('parts' in data) resolve(data.parts); else reject(new Error(data.error));
    };
    worker.onerror = event => { event.preventDefault(); reject(new Error('This image could not be encoded.')); };
    worker.postMessage({ raster: r, keep }, [r.data.buffer]);
  }).finally(() => worker.terminate());
}

/** An image document read from the route `load` and written to `save`, under
 * `name`: its bytes, decoded as they load. */
export const imageSource = (load: string, save: string, name: string): DocumentSource<Blob, ImageLoad> => ({
  async load() {
    const response = await checked(await fetch(load, { cache: 'no-store' }));
    const content: ImageLoad = response.headers.get('Content-Type')?.startsWith('application/json')
      ? { viewOnly: String((await response.json()).viewOnly) }
      : await decodeImage(await response.blob());
    return { content, version: response.headers.get(VERSION_HEADER) ?? '', name };
  },
  async save(blob, version) {
    const response = await checked(await fetch(`${save}?version=${encodeURIComponent(version)}`, {
      method: 'POST', headers: { 'Content-Type': blob.type }, body: blob,
    }));
    return response.json();
  },
});
