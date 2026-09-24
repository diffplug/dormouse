import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// These CLI entrypoints also serve the renderer (the format helper serves the
// host). Node types in the CLI must not admit a runtime Node dependency here.
test('shared CLI modules bundle for a browser without Node shims', async () => {
  await build({
    entryPoints: ['commands/types', 'commands/shell-quote', 'protocol', 'file-viewer-format']
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
