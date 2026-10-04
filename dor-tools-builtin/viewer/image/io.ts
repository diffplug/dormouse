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

/** An image file's pixels, exactly as stored (no premultiplication or color
 * conversion where the browser honors the request), and the format a save
 * keeps. The page's CSP has no `blob:` images, so this decodes without an `<img>`. */
export async function decodeImage(blob: Blob): Promise<LoadedImage> {
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  try {
    const { width, height } = bitmap, canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    return { raster: { width, height, data: ctx.getImageData(0, 0, width, height).data }, mime: blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/png' };
  } finally { bitmap.close(); }
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
