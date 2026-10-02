import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Runs after tsc: the self-contained Node runtime replaces tsc's re-export
// `dist/runtime.js`, and the Monaco and Markdown pages land beside it in
// `dist/viewer`, whose files `viewerAsset` serves by name.
const absWorkingDir = fileURLToPath(new URL('../', import.meta.url));
// Mermaid's optional ELK layouts load elkjs (EPL-2.0, 1.4 MB); the page ships
// without it, so a `layout: elk` diagram shows this error instead.
const withoutElk = {
  name: 'without-elk',
  setup(build) {
    build.onResolve({ filter: /^elkjs(\/|$)/ }, () => ({ path: 'elkjs', namespace: 'without-elk' }));
    build.onLoad({ filter: /.*/, namespace: 'without-elk' }, () => ({
      contents: "export default class { constructor() { throw new Error('ELK layouts are not available in this editor.'); } }",
    }));
  },
};
// Chunk names carry content hashes; a stale one would still be served.
await rm(new URL('../dist/viewer/', import.meta.url), { recursive: true, force: true });
await Promise.all([
  build({
    absWorkingDir,
    entryPoints: ['src/runtime.ts'],
    outfile: 'dist/runtime.js', bundle: true, format: 'esm', platform: 'node',
    target: 'node24',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  }),
  build({
    absWorkingDir,
    entryPoints: { editor: 'viewer/editor.ts', 'editor.worker': 'node_modules/monaco-editor/esm/vs/editor/editor.worker.js' },
    outdir: 'dist/viewer', bundle: true, format: 'esm', platform: 'browser',
    target: 'es2022', minify: true, loader: { '.ttf': 'file' }, assetNames: '[name]',
  }),
  // Mermaid and CodeMirror's languages load as split chunks on first use.
  build({
    absWorkingDir,
    entryPoints: { markdown: 'viewer/markdown.tsx' },
    outdir: 'dist/viewer', bundle: true, format: 'esm', platform: 'browser', splitting: true,
    target: 'es2022', minify: true, jsx: 'automatic', chunkNames: 'markdown-[hash]',
    loader: { '.ttf': 'file', '.woff': 'file', '.woff2': 'file' }, assetNames: 'markdown-[name]-[hash]',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [withoutElk],
  }),
]);
