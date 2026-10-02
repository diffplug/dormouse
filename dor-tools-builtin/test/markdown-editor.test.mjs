import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { afterEach, beforeEach, test } from 'node:test';
import { startFileViewer } from '../dist/file-viewer.js';
import { writePastedImage } from '../dist/markdown-images.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108020000009077' + '53de0000000c4944415408d763f8cfc000000301010018dd8db00000000049454e44ae426082', 'hex');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);

let root;
let docs;
const viewers = [];
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dor-markdown-')));
  docs = join(root, 'docs');
  await mkdir(join(docs, 'img'), { recursive: true });
  await writeFile(join(docs, 'img', 'a b.png'), PNG);
  await writeFile(join(docs, 'secret.txt'), 'secret');
  await writeFile(join(root, 'outside.png'), PNG);
});
afterEach(async () => {
  await Promise.all(viewers.splice(0).map(v => v.close()));
  await rm(root, { recursive: true, force: true });
});
async function start(name = 'doc.md', contents = '# Doc\n\n![a](img/a%20b.png)\n') {
  await writeFile(join(docs, name), contents);
  const viewer = await startFileViewer(join(docs, name));
  viewers.push(viewer);
  return viewer;
}
const route = (viewer, path) => viewer.path.replace(/view$/, path);
function send(viewer, path, { method = 'GET', body, origin = `http://127.0.0.1:${viewer.port}` } = {}) {
  return new Promise((resolve, reject) => {
    const headers = body === undefined ? {} : { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) };
    const req = request({ host: '127.0.0.1', port: viewer.port, path, method: body === undefined ? method : 'POST', headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const paste = (viewer, type, bytes, origin) => send(viewer, route(viewer, 'image'), { body: { type, data: bytes.toString('base64') }, origin });
const rename = (viewer, from, to) => send(viewer, route(viewer, 'rename'), { body: { from, to } });

test('Markdown opens in the rich editor page under a policy that frames and embeds nothing', async () => {
  const viewer = await start('doc.md', '<script>bad()</script>');
  const page = await send(viewer, viewer.path);
  assert.equal(page.status, 200);
  assert.match(page.body.toString(), /assets\/markdown\.js/);
  assert.ok(!page.body.toString().includes('bad()'));
  const csp = page.headers['content-security-policy'];
  for (const directive of ["frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"]) assert.ok(csp.includes(directive), directive);
  assert.equal((await send(viewer, route(viewer, 'assets/markdown.js'))).status, 200);
  assert.equal((await send(viewer, route(viewer, 'assets/markdown.css'))).status, 200);
  assert.equal((await send(viewer, route(viewer, 'assets/..%2Fruntime.js'))).status, 403);
  assert.equal((await send(viewer, route(viewer, 'assets/runtime.js'))).status, 404);
});

test('serves images at or under the document folder, sandboxed, and nothing else', { skip: process.platform === 'win32' }, async () => {
  const viewer = await start();
  const image = await send(viewer, route(viewer, 'file/img/a%20b.png'));
  assert.equal(image.status, 200);
  assert.equal(image.headers['content-type'], 'image/png');
  assert.ok(image.body.equals(PNG));
  assert.match(image.headers['content-security-policy'], /^sandbox;/);
  assert.equal((await send(viewer, route(viewer, 'file/secret.txt'))).status, 404);
  // URL parsing removes a literal `..`; an encoded slash reaches the segment check.
  assert.equal((await send(viewer, route(viewer, 'file/../outside.png'))).status, 404);
  assert.equal((await send(viewer, route(viewer, 'file/..%2Foutside.png'))).status, 403);
  await symlink(join(root, 'outside.png'), join(docs, 'escape.png'));
  assert.equal((await send(viewer, route(viewer, 'file/escape.png'))).status, 404);
  await symlink(join(docs, 'img', 'a b.png'), join(docs, 'alias.png'));
  assert.equal((await send(viewer, route(viewer, 'file/alias.png'))).status, 200);
  // Other text keeps its one-file grant.
  const notes = await start('notes.txt', 'plain');
  assert.equal((await send(notes, route(notes, 'file/img/a%20b.png'))).status, 404);
});

test('pasted images become new files beside the document, checked against their type', async () => {
  const viewer = await start();
  const first = await paste(viewer, 'image/png', PNG);
  assert.equal(first.status, 200, first.body.toString());
  const { name } = JSON.parse(first.body);
  assert.match(name, /^image-\d{8}-\d{6}(-\d+)?\.png$/);
  assert.ok((await readFile(join(docs, name))).equals(PNG));
  for (const origin of ['', 'null', 'https://elsewhere.test']) assert.equal((await paste(viewer, 'image/png', PNG, origin)).status, 403);
  assert.equal((await paste(viewer, 'image/svg+xml', Buffer.from('<svg/>'))).status, 415);
  assert.equal((await paste(viewer, 'image/png', JPEG)).status, 415);
  assert.equal((await paste(viewer, 'constructor', PNG)).status, 415);
  const notes = await start('notes.txt', 'plain');
  assert.equal((await paste(notes, 'image/png', PNG)).status, 404);
});

test('a paste never replaces an existing file', async () => {
  const now = new Date(2026, 9, 2, 13, 4, 5);
  await writeFile(join(docs, 'image-20261002-130405.png'), 'existing');
  assert.equal(await writePastedImage(docs, 'image/png', PNG, now), 'image-20261002-130405-2.png');
  assert.equal(await writePastedImage(docs, 'image/jpeg', JPEG, now), 'image-20261002-130405.jpg');
  assert.equal(await readFile(join(docs, 'image-20261002-130405.png'), 'utf8'), 'existing');
});

test('image renames stay in their folder, keep an image name, and never replace a file', { skip: process.platform === 'win32' }, async () => {
  const viewer = await start();
  await writeFile(join(docs, 'img', 'taken.png'), PNG);
  assert.equal((await rename(viewer, 'img/a b.png', 'img/taken.png')).status, 409);
  assert.equal((await rename(viewer, 'img/a b.png', 'moved.png')).status, 400);
  assert.equal((await rename(viewer, 'img/a b.png', 'img/.hidden.png')).status, 400);
  assert.equal((await rename(viewer, 'img/a b.png', 'img/notes.txt')).status, 404);
  assert.equal((await rename(viewer, 'secret.txt', 'secret.png')).status, 404);
  assert.equal((await rename(viewer, '../outside.png', '../renamed.png')).status, 404);
  await symlink(join(root, 'outside.png'), join(docs, 'escape.png'));
  assert.equal((await rename(viewer, 'escape.png', 'kept.png')).status, 404);
  const renamed = await rename(viewer, 'img/a b.png', 'img/diagram.png');
  assert.equal(renamed.status, 200, renamed.body.toString());
  assert.deepEqual((await readdir(join(docs, 'img'))).sort(), ['diagram.png', 'taken.png']);
  assert.ok((await readFile(join(docs, 'img', 'diagram.png'))).equals(PNG));
  assert.equal((await rename(viewer, 'img/diagram.png', 'img/Diagram.png')).status, 200);
  assert.ok((await readdir(join(docs, 'img'))).includes('Diagram.png'));
});
