import { readFile } from 'node:fs/promises';

// Resolves beside dist/dor.js in the staged CLI and beside dist/file-viewer.js
// in tests. Source imports from lib tests use the same built artifacts.
const root = new URL('../dist/pdf-viewer/', import.meta.url);
const MIME: Record<string, string> = {
  mjs: 'text/javascript; charset=utf-8', js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', svg: 'image/svg+xml', wasm: 'application/wasm',
};

/** A build-generated exact inventory, never a directory/file URL supplied by
 * the document. These application assets do not enlarge its file grant. */
export async function pdfViewerAssets() {
  let manifest: unknown;
  try { manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8')); }
  catch { throw new Error('PDF renderer is missing; rebuild or reinstall Dormouse'); }
  if (!Array.isArray(manifest) || !manifest.every(name => typeof name === 'string'
    && /^[a-zA-Z0-9_.\/-]+$/.test(name) && !name.split('/').some(part => part === '..' || part === '.' || part === ''))) {
    throw new Error('Invalid PDF renderer asset inventory');
  }
  const allowed = new Set<string>(manifest);
  const html = await readFile(new URL('viewer.html', root), 'utf8');
  return {
    html,
    async read(name: string): Promise<{ bytes: Buffer; mime: string } | null> {
      if (!allowed.has(name) || name === 'viewer.html') return null;
      return { bytes: await readFile(new URL(name, root)), mime: MIME[name.split('.').pop()!] ?? 'application/octet-stream' };
    },
  };
}
