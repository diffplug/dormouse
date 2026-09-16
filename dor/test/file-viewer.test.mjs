import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, beforeEach, test } from 'node:test';
import { startFileViewer } from '../dist/file-viewer.js';
import { fileViewerFormat } from '../dist/file-viewer-format.js';
import { stageDorCli } from '../../scripts/stage-dor-cli.mjs';
import { buildPdfViewer } from '../scripts/build-pdf-viewer.mjs';

let root;
const viewers = [];
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'dor-viewer-'))); });
afterEach(async () => {
  await Promise.all(viewers.splice(0).map(v => v.close()));
  await rm(root, { recursive: true, force: true });
});
async function start(name, contents) {
  const file = join(root, name);
  await writeFile(file, contents);
  const viewer = await startFileViewer(file);
  viewers.push(viewer);
  return viewer;
}
async function get(viewer, path = viewer.path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: viewer.port, path, headers, method }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}
const asset = (viewer, path) => viewer.path.replace(/\/file\/.*$/, `/file/${path}`);

test('known formats override source-name heuristics without treating prototype keys as formats', () => {
  for (const [name, mime] of [['README.pdf', 'application/pdf'], ['readme.png', 'image/png'], ['LICENSE.html', 'text/html; charset=utf-8']]) {
    assert.deepEqual(fileViewerFormat(name), { mime, text: false });
  }
  for (const name of ['README', 'Dockerfile.dev', 'README.md', '.gitignore']) {
    assert.deepEqual(fileViewerFormat(name), { mime: 'text/plain; charset=utf-8', text: true });
  }
  assert.deepEqual(fileViewerFormat('README.css'), { mime: 'text/css; charset=utf-8', text: true });
  assert.equal(fileViewerFormat('file.constructor'), null);
});

test('renders text as escaped content and requires the per-run token on every method', async () => {
  const viewer = await start('README.md', '<script>bad()</script> & hello');
  const good = await get(viewer);
  assert.equal(good.status, 200);
  assert.match(good.body, /&lt;script&gt;bad\(\)&lt;\/script&gt; &amp; hello/);
  assert.equal(good.headers['referrer-policy'], 'no-referrer');
  assert.equal(good.headers['cache-control'], 'no-store');
  for (const path of ['/', '/wrong/view', viewer.path.replace(/\/[a-f0-9]{64}\//, '/')]) {
    assert.equal((await get(viewer, path)).status, 403);
  }
  assert.equal((await get(viewer, viewer.path, { Host: `evil.test:${viewer.port}` })).status, 403);
  assert.equal((await get(viewer, viewer.path, { Host: `LOCALHOST:${viewer.port}` })).status, 200);
  const prefix = viewer.path.split('/')[1];
  for (const token of [prefix.slice(1), prefix + '0', `${prefix[0] === '0' ? '1' : '0'}${prefix.slice(1)}`, `${prefix.slice(0, -1)}${prefix.at(-1) === '0' ? '1' : '0'}`]) {
    assert.equal((await get(viewer, viewer.path.replace(prefix, token))).status, 403);
  }
  assert.equal((await get(viewer, viewer.path, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await get(viewer, viewer.path, {}, 'POST')).status, 403);
  assert.equal((await get(viewer, viewer.path, {}, 'HEAD')).body, '');
  const second = await startFileViewer(join(root, 'README.md'));
  viewers.push(second);
  assert.notEqual(second.path, viewer.path);
  assert.equal((await get(second, viewer.path)).status, 403);
});

test('serves only the HTML document and its bounded relative dependency graph', async () => {
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'assets', 'style.css'), '@import "more.css"; body { background: url(pic.svg) }');
  await writeFile(join(root, 'assets', 'more.css'), 'body { color: red }');
  await writeFile(join(root, 'assets', 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(join(root, 'unreferenced.txt'), 'private sibling');
  const viewer = await start('LICENSE.html', '<link href="assets/style.css" rel="stylesheet"><h1>Preview</h1>');
  const response = await get(viewer);
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(response.body, /<h1>Preview<\/h1>/);
  for (const path of ['assets/style.css', 'assets/more.css', 'assets/pic.svg']) assert.equal((await get(viewer, asset(viewer, path))).status, 200);
  assert.equal((await get(viewer, asset(viewer, 'unreferenced.txt'))).status, 404);
  assert.notEqual((await get(viewer, asset(viewer, '%2e%2e/unreferenced.txt'))).status, 200);
  assert.equal((await get(viewer, asset(viewer, '%E0%A4%A'))).status, 400);
  assert.equal((await get(viewer, asset(viewer, 'assets/style.css'))).status, 200); // repeated streams retain the grant
});

test('rejects parent-directory references and symlinks escaping the document directory', { skip: process.platform === 'win32' }, async () => {
  await mkdir(join(root, 'page'));
  await writeFile(join(root, 'secret.txt'), 'secret');
  await symlink(join(root, 'secret.txt'), join(root, 'page', 'linked.txt'));
  const viewer = await start('page/index.html', '<iframe src="../secret.txt"></iframe><iframe src="linked.txt"></iframe>');
  assert.equal((await get(viewer, asset(viewer, 'linked.txt'))).status, 404);
  assert.notEqual((await get(viewer, asset(viewer, '../secret.txt'))).status, 200);
});

test('keeps descriptor-backed PDF byte ranges and HEAD behind the rendered preview', async () => {
  const opened = await start('README.pdf', '%PDF-1.7 example bytes');
  const viewer = { ...opened, path: opened.path.replace(/view$/, 'file/README.pdf') };
  assert.equal((await get(viewer)).headers['content-type'], 'application/pdf');
  const range = await get(viewer, viewer.path, { Range: 'bytes=0-3' });
  assert.equal(range.status, 206);
  assert.equal(range.body, '%PDF');
  assert.equal((await get(viewer, viewer.path, { Range: 'bytes=-5' })).body, 'bytes');
  assert.equal((await get(viewer, viewer.path, { Range: 'bytes=999-1000' })).status, 416);
  assert.equal((await get(viewer, viewer.path, { Range: 'bytes=0-1,4-6' })).status, 416);
  assert.equal((await get(viewer, viewer.path, {}, 'HEAD')).body, '');
});

test('serves an exact capability-gated PDF renderer inventory with narrowly scoped WASM permission', async () => {
  const viewer = await start('report & notes.pdf', '%PDF-1.7 example bytes');
  const prefix = viewer.path.slice(0, -'view'.length);
  const shell = await get(viewer);
  assert.equal(shell.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(shell.body, /report &amp; notes.pdf/);
  assert.match(shell.body, /data-document="\.\/file\/report%20%26%20notes.pdf"/);
  assert.match(shell.body, /Page number/);
  assert.match(shell.headers['content-security-policy'], /worker-src 'self'/);
  assert.match(shell.headers['content-security-policy'], /'wasm-unsafe-eval'/);
  assert.doesNotMatch(shell.headers['content-security-policy'], /(?:^| )'unsafe-eval'/);
  for (const name of ['viewer.mjs', 'controller.mjs', 'pdf.mjs', 'pdf.worker.mjs', 'pdf_viewer.css', 'viewer.css',
    'cmaps/Adobe-Japan1-UCS2.bcmap', 'standard_fonts/LiberationSans-Regular.ttf', 'wasm/openjpeg.wasm', 'LICENSE']) {
    const path = `${prefix}pdfjs/${name}`;
    const response = await get(viewer, path);
    assert.equal(response.status, 200, name);
    assert.ok(response.body.length > 0, name);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['content-security-policy'].includes("'wasm-unsafe-eval'"), name === 'pdf.worker.mjs');
    assert.equal((await get(viewer, path, {}, 'HEAD')).body, '');
    assert.equal((await get(viewer, path, { Origin: 'https://evil.test' })).status, 403);
    assert.equal((await get(viewer, path.replace(prefix, '/wrong/'))).status, 403);
  }
  for (const name of ['manifest.json', 'viewer.html', '../package.json', '%2e%2e/package.json', 'pdf.sandbox.mjs', 'wasm/quickjs-eval.wasm']) {
    assert.notEqual((await get(viewer, `${prefix}pdfjs/${name}`)).status, 200, name);
  }
  assert.equal((await get(viewer, `${prefix}file/private.pdf`)).status, 404);
  const text = await start('plain.txt', 'text');
  assert.equal((await get(text, text.path.replace(/view$/, 'pdfjs/pdf.mjs'))).status, 404);
});

test('fails unsupported formats and oversized text before starting a viewer', async () => {
  await writeFile(join(root, 'unknown.bin'), 'binary');
  await assert.rejects(startFileViewer(join(root, 'unknown.bin')), /unsupported/);
  await writeFile(join(root, 'large.txt'), Buffer.alloc(8 * 1024 * 1024 + 1));
  await assert.rejects(startFileViewer(join(root, 'large.txt')), /8 MiB/);
});

test('streams oversized HTML and referenced CSS without scanning their dependencies', async () => {
  const large = ' '.repeat(8 * 1024 * 1024 + 1);
  await writeFile(join(root, 'hidden.svg'), '<svg/>');
  const html = await start('large.html', `<img src="hidden.svg">${large}`);
  const htmlResponse = await get(html);
  assert.equal(htmlResponse.status, 200);
  assert.equal(htmlResponse.body.length, large.length + '<img src="hidden.svg">'.length);
  assert.equal((await get(html, asset(html, 'hidden.svg'))).status, 404);

  await writeFile(join(root, 'large.css'), `body { background: url(hidden.svg) }${large}`);
  const withCss = await start('index.html', '<link href="large.css" rel="stylesheet">');
  const cssResponse = await get(withCss, asset(withCss, 'large.css'));
  assert.equal(cssResponse.status, 200);
  assert.ok(cssResponse.body.length > 8 * 1024 * 1024);
  assert.equal((await get(withCss, asset(withCss, 'hidden.svg'))).status, 404);
  await assert.rejects(startFileViewer(join(root, 'large.css')), /8 MiB/); // a direct CSS text preview stays capped
});

test('previews CSS source without granting dependencies but still bounds HTML-referenced CSS', async () => {
  const names = Array.from({ length: 256 }, (_, i) => `image${i}.svg`);
  await Promise.all(names.map(name => writeFile(join(root, name), '<svg/>')));
  const css = names.map(name => `body { background: url("${name}") }`).join('\n');
  const viewer = await start('source.css', css);
  const response = await get(viewer);
  assert.equal(response.status, 200);
  assert.match(response.body, /url\(&quot;image255.svg&quot;\)/);
  const prefix = viewer.path.slice(0, -'view'.length);
  assert.equal((await get(viewer, `${prefix}file/image0.svg`)).status, 404);
  assert.equal((await get(viewer, `${prefix}file/source.css`)).status, 200);

  // The same CSS is an active stylesheet when reached through HTML. Its
  // dependencies still count against that viewer's grant and abort the open.
  await writeFile(join(root, 'index.html'), '<link rel="stylesheet" href="source.css">');
  await assert.rejects(startFileViewer(join(root, 'index.html')), /256 referenced files/);
});

test('bounds the asset graph and keeps a grant on the opened file after path replacement', async () => {
  const viewer = await start('original.txt', 'original content');
  await rm(join(root, 'original.txt'));
  await writeFile(join(root, 'original.txt'), 'replacement content');
  assert.match((await get(viewer)).body, /original content/);
  const names = Array.from({ length: 256 }, (_, i) => `style${i}.css`);
  await Promise.all(names.map(name => writeFile(join(root, name), '')));
  const html = join(root, 'many.html');
  await writeFile(html, names.map(name => `<link href="${name}" rel="stylesheet">`).join(''));
  await assert.rejects(startFileViewer(html), /256 referenced files/);
});

test('the staged private entry serves PDF assets without node_modules and exits on termination', { timeout: 10_000 }, async () => {
  const file = join(root, 'cli.pdf');
  await writeFile(file, '%PDF-1.7 example bytes');
  const staged = join(root, 'staged');
  await stageDorCli(staged);
  // The library pretest runs this asset-only prerequisite on a clean checkout.
  // Rebuild into an empty staged directory, without relying on dor's artifacts.
  const assets = join(staged, 'dist/pdf-viewer');
  await rm(assets, { recursive: true });
  await buildPdfViewer(assets);
  const child = spawn(process.execPath, [join(staged, 'dist/dor.js'), '__view-file', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let output = '';
    const announce = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`viewer exited early: ${code}`)));
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = /\x1b\]367;serve;(\{[^\x07]*\})\x07/.exec(output);
        if (match) resolve(JSON.parse(match[1]));
      });
    });
    assert.match((await get(announce)).body, /PDF controls/);
    assert.equal((await get(announce, announce.path.replace(/view$/, 'pdfjs/pdf.worker.mjs'))).status, 200);
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
    await assert.rejects(get(announce));
  } finally { child.kill('SIGKILL'); }
});
