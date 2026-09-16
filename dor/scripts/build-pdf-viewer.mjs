import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const pdfjs = dirname(require.resolve('pdfjs-dist/package.json'));
const dor = fileURLToPath(new URL('../', import.meta.url));
export async function buildPdfViewer(output = join(dor, 'dist/pdf-viewer')) {
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  // Browser artifacts only: never import PDF.js (or its optional native canvas)
  // into the Node CLI. Both hosts stage this directory along with dor.js.
  for (const [source, target] of [
    ['legacy/build/pdf.min.mjs', 'pdf.mjs'],
    ['legacy/build/pdf.worker.min.mjs', 'pdf.worker.mjs'],
    ['web/pdf_viewer.css', 'pdf_viewer.css'],
    ['web/images', 'images'],
    ['cmaps', 'cmaps'],
    ['standard_fonts', 'standard_fonts'],
    ['iccs', 'iccs'],
    ['LICENSE', 'LICENSE'],
  ]) await cp(join(pdfjs, source), join(output, target), { recursive: true });
  await mkdir(join(output, 'wasm'));
  for (const name of [
    'openjpeg.wasm', 'openjpeg_nowasm_fallback.js', 'jbig2.wasm', 'jbig2_nowasm_fallback.js', 'qcms_bg.wasm',
    'LICENSE_JBIG2', 'LICENSE_OPENJPEG', 'LICENSE_PDFJS_JBIG2', 'LICENSE_PDFJS_OPENJPEG', 'LICENSE_PDFJS_QCMS', 'LICENSE_QCMS',
  ]) await cp(join(pdfjs, 'wasm', name), join(output, 'wasm', name));
  for (const name of ['viewer.html', 'viewer.css', 'viewer.mjs', 'controller.mjs']) {
    await cp(join(dor, 'viewer', name), join(output, name));
  }
  const files = [];
  async function inventory(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await inventory(join(directory, entry.name), name + '/');
      else if (entry.isFile()) files.push(name);
      else throw new Error(`Unexpected PDF viewer asset: ${name}`);
    }
  }
  await inventory(output);
  await writeFile(join(output, 'manifest.json'), JSON.stringify(files.sort()) + '\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await buildPdfViewer();
