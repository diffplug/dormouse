/** What the image editor's tests share: `viewer/` is bundled for the browser,
 * never compiled to dist, so the tests bundle it too. */
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/** The module at `path` (relative to this folder), bundled and imported. */
export async function load(path) {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL(path, import.meta.url))],
    bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent',
  });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}

export const px = await load('../viewer/image/pixels.ts');
export const WHITE = [255, 255, 255, 255];

/** A `width` × `height` raster filled with `color`. */
export function raster(width, height, color = WHITE) {
  const r = px.createRaster(width, height);
  px.fillRect(r, { x: 0, y: 0, width, height }, color);
  return r;
}
