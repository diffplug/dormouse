import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { buildViewerAssets } from './build-viewer.mjs';

// Runs after tsc: the self-contained Node runtime replaces tsc's re-export
// `dist/runtime.js`, and the Monaco and Markdown pages land beside it in
// `dist/viewer`, whose files `viewerAsset` serves by name.
const absWorkingDir = fileURLToPath(new URL('../', import.meta.url));
await Promise.all([
  build({
    absWorkingDir,
    entryPoints: ['src/runtime.ts'],
    outfile: 'dist/runtime.js', bundle: true, format: 'esm', platform: 'node',
    target: 'node24',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  }),
  buildViewerAssets(fileURLToPath(new URL('../dist/viewer/', import.meta.url))),
]);
