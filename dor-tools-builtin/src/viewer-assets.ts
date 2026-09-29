import { readFile } from 'node:fs/promises';
import { fileViewerFormat } from './file-viewer-format.js';
import { HttpError } from './viewer-server.js';

const ASSETS = new Set(['editor.js', 'editor.worker.js', 'editor.css', 'codicon.ttf']);

/** Build-owned resources, separate from the user's document grant. */
export async function viewerAsset(name: string): Promise<{ bytes: Buffer; mime: string }> {
  if (!ASSETS.has(name)) throw new HttpError(404);
  return { bytes: await readFile(new URL(`./viewer/${name}`, import.meta.url)), mime: fileViewerFormat(name)!.mime };
}
