import { readdir, readFile } from 'node:fs/promises';
import { fileViewerFormat } from './file-viewer-format.js';
import { HttpError } from './viewer-server.js';

const directory = new URL('./viewer/', import.meta.url);
let shipped: Promise<Set<string>> | undefined;

/** Build-owned resources, separate from the user's document grant: the files
 * the build placed in the adjacent `viewer` directory, by exact name. */
export async function viewerAsset(name: string): Promise<{ bytes: Buffer; mime: string }> {
  shipped ??= readdir(directory, { withFileTypes: true }).then(entries => new Set(entries.filter(e => e.isFile()).map(e => e.name)));
  const mime = fileViewerFormat(name)?.mime;
  if (!(await shipped).has(name) || !mime) throw new HttpError(404);
  return { bytes: await readFile(new URL(name, directory)), mime };
}
