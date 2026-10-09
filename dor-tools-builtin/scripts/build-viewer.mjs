import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

const absWorkingDir = fileURLToPath(new URL('../', import.meta.url));
// From source, as the website's Vite build resolves it: the website builds
// these assets from a checkout where dor-tools-lib has no dist yet.
const alias = { 'dor-tools-lib': fileURLToPath(new URL('../../dor-tools-lib/src', import.meta.url)) };

/** Bundles the Monaco, Markdown, and image pages' assets, and the folder
 * viewer's tooltip, into `outdir`, which `viewerAsset` serves by name; the
 * website playground builds its own copy. */
export async function buildViewerAssets(outdir) {
  // Chunk names carry content hashes; a stale one would still be served.
  await rm(outdir, { recursive: true, force: true });
  await Promise.all([
    build({
      absWorkingDir,
      entryPoints: { editor: 'viewer/editor.ts', 'editor.worker': 'node_modules/monaco-editor/esm/vs/editor/editor.worker.js' },
      outdir, bundle: true, format: 'esm', platform: 'browser', alias,
      target: 'es2022', minify: true, loader: { '.ttf': 'file' }, assetNames: '[name]',
    }),
    // Mermaid and CodeMirror's languages load as split chunks on first use.
    build({
      absWorkingDir,
      entryPoints: { markdown: 'viewer/markdown.tsx' },
      outdir, bundle: true, format: 'esm', platform: 'browser', splitting: true, alias,
      target: 'es2022', minify: true, jsx: 'automatic', chunkNames: 'markdown-[hash]',
      loader: { '.ttf': 'file', '.woff': 'file', '.woff2': 'file' }, assetNames: 'markdown-[name]-[hash]',
      define: { 'process.env.NODE_ENV': '"production"' },
    }),
    // The image editor: `image.js` and `image.css`, no chunks, and its PNG
    // encoder's worker, `image.worker.js`.
    build({
      absWorkingDir,
      entryPoints: { image: 'viewer/image/main.tsx', 'image.worker': 'viewer/image/png-worker.ts' },
      outdir, bundle: true, format: 'esm', platform: 'browser', alias,
      target: 'es2022', minify: true, jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
    }),
    // The folder viewer's tooltip, a classic script: `tooltip.js` and `tooltip.css`.
    build({
      absWorkingDir,
      entryPoints: { tooltip: 'viewer/tooltip-page.ts' },
      outdir, bundle: true, format: 'iife', platform: 'browser', target: 'es2022', minify: true,
    }),
  ]);
}

// `node scripts/build-viewer.mjs <outdir>`
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('usage: build-viewer.mjs <outdir>');
  await buildViewerAssets(process.argv[2]);
}
