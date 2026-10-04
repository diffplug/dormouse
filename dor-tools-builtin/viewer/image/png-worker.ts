/** The PNG codec off the page's thread (`assets/image.worker.js`), so neither
 * opening nor saving a large image holds the page. An encode takes a raster
 * the page no longer holds and the chunks to keep, and answers the file's
 * parts; a decode takes the file's bytes and answers `decodePng`'s result.
 * Either hands its buffers back rather than copying them. */
import { decodePng, encodePng } from './png';
import type { Raster } from './pixels';

export type PngJob = { encode: { raster: Raster; keep: readonly Uint8Array[] } } | { decode: Uint8Array };

/** Answers `result`, transferring the buffers under `parts`. */
const reply = (result: unknown, parts: readonly ArrayBufferView[]) =>
  postMessage({ result }, { transfer: [...new Set(parts.map(part => part.buffer as ArrayBuffer))] });

self.onmessage = async ({ data }: MessageEvent<PngJob>) => {
  try {
    if ('decode' in data) {
      const png = await decodePng(data.decode);
      reply(png, [png.raster.data, ...png.keep, ...png.profile ? [png.profile] : []]);
    } else {
      const parts = await encodePng(data.encode.raster, data.encode.keep);
      reply(parts, parts);
    }
  } catch (reason) {
    postMessage({ error: reason instanceof Error ? reason.message : String(reason) });
  }
};
