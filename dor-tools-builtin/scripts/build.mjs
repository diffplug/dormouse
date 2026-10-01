import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Runs after tsc: the self-contained Node runtime replaces tsc's re-export
// `dist/runtime.js`, and the Monaco page lands beside it in `dist/viewer`.
const absWorkingDir = fileURLToPath(new URL('../', import.meta.url));
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
]);
