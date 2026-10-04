/** Getting pixels in and out of the image editor, and the HTTP shape both
 * image routes share (docs/specs/dor-tools-builtin.md -> Image editor): a GET
 * returns the bytes with their revision in `X-Dor-Version`; a save POSTs the
 * bytes with `?version=` and answers `{version}`. */
import type { Raster } from './pixels';

export type EditableMime = 'image/png' | 'image/jpeg';
export const VERSION_HEADER = 'X-Dor-Version';

/** The pixels of an image file, exactly as stored (no premultiplication or
 * color conversion where the browser honors the request). The page's CSP has
 * no `blob:` images, so this decodes without an `<img>`. */
export async function decodeImage(blob: Blob): Promise<Raster> {
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

async function failure(response: Response) {
  return new Error(await response.text() || `Request failed (${response.status})`);
}

/** GETs an editable image and the revision it is at. */
export async function fetchImage(path: string): Promise<{ blob: Blob; version: string }> {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw await failure(response);
  return { blob: await response.blob(), version: response.headers.get(VERSION_HEADER) ?? '' };
}

/** POSTs `blob` over the revision `version`; resolves to the new revision. */
export async function saveImage(path: string, blob: Blob, version: string): Promise<{ version: string }> {
  const response = await fetch(`${path}?version=${encodeURIComponent(version)}`, {
    method: 'POST', headers: { 'Content-Type': blob.type }, body: blob,
  });
  if (!response.ok) throw await failure(response);
  return response.json();
}
