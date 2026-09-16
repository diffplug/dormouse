import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, test } from 'node:test';
import { startFileViewer } from '../dist/file-viewer.js';

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
  const viewer = await start('index.html', '<link href="assets/style.css" rel="stylesheet"><h1>Preview</h1>');
  assert.equal((await get(viewer)).status, 200);
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

test('supports byte ranges and HEAD for native PDF/image presentation', async () => {
  const viewer = await start('sample.pdf', '%PDF-1.7 example bytes');
  assert.equal((await get(viewer)).headers['content-type'], 'application/pdf');
  const range = await get(viewer, viewer.path, { Range: 'bytes=0-3' });
  assert.equal(range.status, 206);
  assert.equal(range.body, '%PDF');
  assert.equal((await get(viewer, viewer.path, { Range: 'bytes=-5' })).body, 'bytes');
  assert.equal((await get(viewer, viewer.path, { Range: 'bytes=999-1000' })).status, 416);
  assert.equal((await get(viewer, viewer.path, { Range: 'bytes=0-1,4-6' })).status, 416);
  assert.equal((await get(viewer, viewer.path, {}, 'HEAD')).body, '');
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

test('the bundled private entry announces its port and path, then exits on termination', { timeout: 10_000 }, async () => {
  const file = join(root, 'cli.txt');
  await writeFile(file, 'cli preview');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/dor.js', import.meta.url)), '__view-file', file], { stdio: ['ignore', 'pipe', 'pipe'] });
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
    assert.equal((await get(announce)).status, 200);
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
    await assert.rejects(get(announce));
  } finally { child.kill('SIGKILL'); }
});
