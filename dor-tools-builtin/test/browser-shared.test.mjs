import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// The format helper also serves the renderer, which names a preview's target
// with it, and the website playground serves the viewer pages from the page
// builders. Node types in this package must not admit a runtime Node dependency here.
test('the shared modules bundle for a browser without Node shims', async () => {
  await build({
    entryPoints: ['file-viewer-format', 'editor-page', 'folder-viewer-page', 'error-viewer-page']
      .map(name => fileURLToPath(new URL(`../src/${name}.ts`, import.meta.url))),
    outdir: 'browser-shared-test',
    bundle: true,
    platform: 'browser',
    format: 'esm',
    treeShaking: false,
    write: false,
    logLevel: 'silent',
  });
});
