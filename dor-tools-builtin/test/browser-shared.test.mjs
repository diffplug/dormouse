import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// The format helper also serves the renderer, which names a preview's target
// with it. Node types in this package must not admit a runtime Node dependency here.
test('the format helper bundles for a browser without Node shims', async () => {
  await build({
    entryPoints: [fileURLToPath(new URL('../src/file-viewer-format.ts', import.meta.url))],
    outdir: 'browser-shared-test',
    bundle: true,
    platform: 'browser',
    format: 'esm',
    treeShaking: false,
    write: false,
    logLevel: 'silent',
  });
});
