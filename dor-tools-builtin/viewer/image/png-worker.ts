/** `encodePng` off the page's thread (`assets/image.worker.js`), so saving a
 * large image never holds the page: it takes a raster the page no longer
 * holds and the chunks to keep, and answers the file's parts. */
import { encodePng } from './png';
import type { Raster } from './pixels';

self.onmessage = async ({ data }: MessageEvent<{ raster: Raster; keep: Uint8Array[] }>) => {
  try {
    const parts = await encodePng(data.raster, data.keep);
    postMessage({ parts }, { transfer: [...new Set(parts.map(part => part.buffer))] });
  } catch (reason) {
    postMessage({ error: reason instanceof Error ? reason.message : String(reason) });
  }
};
