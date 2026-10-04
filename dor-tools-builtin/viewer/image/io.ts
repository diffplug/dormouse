/** Getting pixels in and out of the image editor, and the HTTP shape both
 * image routes share (docs/specs/dor-tools-builtin.md -> Image editor): a GET
 * returns the bytes with their revision in `X-Dor-Version`; a save POSTs the
 * bytes with `?version=` and answers `{version}`. */
import { VERSION_HEADER } from '../../src/image-format';
import { checked, type DocumentSource } from '../document-session';
import type { Raster } from './pixels';

export type EditableMime = 'image/png' | 'image/jpeg';
/** An image file as the editor opens it. */
export interface LoadedImage { raster: Raster; mime: EditableMime }

/** The pixels of an image file, exactly as stored (no premultiplication or
 * color conversion where the browser honors the request). The page's CSP has
 * no `blob:` images, so this decodes without an `<img>`. */
async function decodeImage(blob: Blob): Promise<Raster> {
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  try { return rasterFromBitmap(bitmap); } finally { bitmap.close(); }
}

export function rasterFromBitmap(bitmap: ImageBitmap): Raster {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return { width: bitmap.width, height: bitmap.height, data };
}

/** GETs and decodes an editable image, with the revision it is at. */
async function loadImage(path: string): Promise<LoadedImage & { version: string }> {
  const response = await checked(await fetch(path, { cache: 'no-store' }));
  const blob = await response.blob();
  return {
    raster: await decodeImage(blob),
    mime: blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/png',
    version: response.headers.get(VERSION_HEADER) ?? '',
  };
}

/** An image document read from the route `load` and written to `save`, under `name`. */
export const imageSource = (load: string, save: string, name: string): DocumentSource<Blob, LoadedImage> => ({
  async load() {
    const { version, ...image } = await loadImage(load);
    return { content: image, version, name };
  },
  async save(blob, version) {
    const response = await checked(await fetch(`${save}?version=${encodeURIComponent(version)}`, {
      method: 'POST', headers: { 'Content-Type': blob.type }, body: blob,
    }));
    return response.json();
  },
});
