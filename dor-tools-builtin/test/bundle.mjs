/** What the image editor's tests share: `viewer/` is bundled for the browser,
 * never compiled to dist, so the tests bundle it too; and the image byte
 * builders, written independently of the readers under test. */
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { build } from 'esbuild';
import { workspaceSourceAliases } from '../../scripts/workspace-sources.mjs';

/** The module at `path` (relative to this folder), bundled and imported. Its
 * `import.meta.url` is its source file's, so a worker URL resolves. */
export async function load(path) {
  const url = new URL(path, import.meta.url);
  const bundle = await build({
    entryPoints: [fileURLToPath(url)],
    bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent',
    alias: workspaceSourceAliases(),
    define: { 'import.meta.url': JSON.stringify(url.href) },
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

/** A PNG chunk of `type` holding `data`, with Node's CRC. */
export function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)]);
  const length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A TIFF block, as EXIF holds one, whose first IFD holds the tags given:
 * Orientation (a SHORT unless `orientationType` says otherwise), XResolution
 * as [numerator, denominator], and ResolutionUnit. Big-endian unless `little`. */
export function tiff({ orientation, orientationType = 3, xres, unit, little = false } = {}) {
  const entries = [];
  if (orientation) entries.push([0x0112, orientationType, orientation]);
  if (xres) entries.push([0x011a, 5, null]);
  if (unit) entries.push([0x0128, 3, unit]);
  // The header, the entry count, the entries, the next IFD's offset (none), then the RATIONAL.
  const rationalAt = 8 + 2 + entries.length * 12 + 4, b = Buffer.alloc(rationalAt + (xres ? 8 : 0));
  const u16 = (v, at) => little ? b.writeUInt16LE(v, at) : b.writeUInt16BE(v, at);
  const u32 = (v, at) => little ? b.writeUInt32LE(v, at) : b.writeUInt32BE(v, at);
  b.write(little ? 'II' : 'MM', 0, 'latin1'); u16(42, 2); u32(8, 4); u16(entries.length, 8);
  entries.forEach(([tag, type, value], i) => {
    const at = 10 + 12 * i;
    u16(tag, at); u16(type, at + 2); u32(1, at + 4);
    if (value === null) u32(rationalAt, at + 8); else u16(value, at + 8);
  });
  if (xres) { u32(xres[0], rationalAt); u32(xres[1], rationalAt + 4); }
  return b;
}
