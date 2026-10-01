import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: { editor: 'viewer/editor.ts', 'editor.worker': 'node_modules/monaco-editor/esm/vs/editor/editor.worker.js' },
  outdir: 'dist/viewer', bundle: true, format: 'esm', platform: 'browser',
  target: 'es2022', minify: true, loader: { '.ttf': 'file' }, assetNames: '[name]',
});
