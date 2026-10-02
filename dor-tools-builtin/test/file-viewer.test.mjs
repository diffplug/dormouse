import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { afterEach, beforeEach, test } from 'node:test';
import { startFileViewer } from '../dist/file-viewer.js';
import { fileViewerFormat, viewerTitle } from '../dist/file-viewer-format.js';

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

async function post(viewer, route, data, origin = `http://127.0.0.1:${viewer.port}`) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: viewer.port, path: viewer.path.replace(/view$/, route), method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(JSON.stringify(data));
  });
}

test('editor saves require same-origin POST and a matching revision, and serve only shipped assets', async () => {
  const viewer = await start('edit.ts', 'export const a = 1;\n');
  const source = JSON.parse((await get(viewer, viewer.path.replace(/view$/, 'source'))).body);
  const data = { text: 'export const a = 2;\n', version: source.version, path: '../unrelated' };
  for (const origin of ['', 'null', 'https://elsewhere.test']) {
    assert.equal((await post(viewer, 'save', data, origin)).status, 403);
  }
  assert.equal((await post(viewer, 'save', data)).status, 200);
  assert.equal(await readFile(join(root, 'edit.ts'), 'utf8'), data.text);
  assert.equal((await post(viewer, 'save', { ...data, text: 'stale' })).status, 409);
  assert.equal((await post(viewer, 'anything', data)).status, 404);
  const prefix = viewer.path.replace(/view$/, '');
  for (const name of ['editor.js', 'editor.css', 'editor.worker.js']) {
    assert.equal((await get(viewer, prefix + 'assets/' + name)).status, 200);
  }
  assert.equal((await get(viewer, prefix + 'assets/package.json')).status, 404);
  const html = await start('active.html', '<h1>Preview</h1>');
  assert.equal((await post(html, 'save', data)).status, 403);
});

test('known formats override source-name heuristics, PDFs never preview, and prototype keys are not formats', () => {
  for (const [name, mime] of [['readme.png', 'image/png'], ['LICENSE.html', 'text/html; charset=utf-8']]) {
    assert.deepEqual(fileViewerFormat(name), { mime, text: false });
  }
  for (const name of ['report.pdf', 'README.pdf', 'LICENSE.PDF']) assert.equal(fileViewerFormat(name), null, name);
  for (const name of ['README', 'Dockerfile.dev', 'README.md', '.gitignore']) {
    assert.deepEqual(fileViewerFormat(name), { mime: 'text/plain; charset=utf-8', text: true });
  }
  assert.deepEqual(fileViewerFormat('README.css'), { mime: 'text/css; charset=utf-8', text: true });
  assert.equal(fileViewerFormat('file.constructor'), null);
});

test('keeps text out of the editor HTML and requires the per-run token on every method', async () => {
  const viewer = await start('README.md', '<script>bad()</script> & hello');
  const good = await get(viewer);
  assert.equal(good.status, 200);
  assert.ok(!good.body.includes('bad()'));
  assert.match(good.body, /assets\/editor.js/);
  const source = await get(viewer, viewer.path.replace(/view$/, 'source'));
  assert.equal(JSON.parse(source.body).text, '<script>bad()</script> & hello');
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

test('supports byte ranges and HEAD for media presentation', async () => {
  const viewer = await start('sample.wav', 'RIFF example bytes');
  assert.equal((await get(viewer)).headers['content-type'], 'audio/wav');
  const range = await get(viewer, viewer.path, { Range: 'bytes=0-3' });
  assert.equal(range.status, 206);
  assert.equal(range.body, 'RIFF');
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

test('previews CSS source without granting dependencies but still bounds HTML-referenced CSS', async () => {
  const names = Array.from({ length: 256 }, (_, i) => `image${i}.svg`);
  await Promise.all(names.map(name => writeFile(join(root, name), '<svg/>')));
  const css = names.map(name => `body { background: url("${name}") }`).join('\n');
  const viewer = await start('source.css', css);
  const response = await get(viewer);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse((await get(viewer, viewer.path.replace(/view$/, 'source'))).body).text, css);
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
  assert.match((await get(viewer, viewer.path.replace(/view$/, 'file/original.txt'))).body, /original content/);
  assert.equal(JSON.parse((await get(viewer, viewer.path.replace(/view$/, 'source'))).body).text, 'replacement content');
  const names = Array.from({ length: 256 }, (_, i) => `style${i}.css`);
  await Promise.all(names.map(name => writeFile(join(root, name), '')));
  const html = join(root, 'many.html');
  await writeFile(html, names.map(name => `<link href="${name}" rel="stylesheet">`).join(''));
  await assert.rejects(startFileViewer(html), /256 referenced files/);
});

test('titles a viewer with its target\'s basename, controls stripped', () => {
  assert.equal(viewerTitle(join(root, 'README.md')), 'README.md');
  // Either separator on every platform: a preview slot switch names its target
  // with it in the renderer.
  for (const [target, title] of [['/repo/docs/', 'docs'], ['C:\\repo\\b.md', 'b.md'], ['/', '/'], ['C:\\', 'C:\\']]) {
    assert.equal(viewerTitle(target), title);
  }
  // C0 (BEL, ESC), DEL, and C1 (NEL, CSI, ST) could end or open a sequence.
  assert.equal(viewerTitle(join(root, 'a\x07\x1b]2;x\x7f\u0085\u009b\u009cb.txt')), 'a]2;xb.txt');
});


test('editor saves atomically while its retained raw grant still reads the original file', async () => {
  const viewer = await start('save.ts', 'original');
  const sourcePath = viewer.path.replace(/view$/, 'source');
  const first = JSON.parse((await get(viewer, sourcePath)).body);
  const saved = await post(viewer, 'save', { text: 'edited', version: first.version });
  assert.equal(saved.status, 200, saved.body);
  const next = JSON.parse((await get(viewer, sourcePath)).body);
  assert.equal(next.text, 'edited');
  assert.equal(next.version, JSON.parse(saved.body).version);
  const raw = await get(viewer, viewer.path.replace(/view$/, 'file/save.ts'));
  assert.equal(raw.status, 200);
  assert.equal(raw.body, 'original');
});
