import { readFile } from 'node:fs/promises';
import { HttpError } from './viewer-server.js';

/** Build-owned resources, separate from the user's document grant. */
export async function viewerAsset(name: string): Promise<{ bytes: Buffer; mime: string }> {
  const mime: Record<string, string> = {
    'editor.js': 'text/javascript', 'editor.worker.js': 'text/javascript',
    'editor.css': 'text/css', 'codicon.ttf': 'font/ttf',
  };
  if (!Object.hasOwn(mime, name)) throw new HttpError(404);
  return { bytes: await readFile(new URL(`./viewer/${name}`, import.meta.url)), mime: mime[name] };
}
