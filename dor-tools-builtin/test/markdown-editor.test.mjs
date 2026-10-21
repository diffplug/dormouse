import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { request } from 'node:http';
import { afterEach, beforeEach, test } from 'node:test';
import { startFileViewer } from '../dist/file-viewer.js';
import { editorStore } from '../dist/editor-store.js';
import { pasteImage } from '../dist/editor-routes.js';
import { resolveInside } from '../dist/viewer-server.js';

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
function send(viewer, path, { method = 'GET', body, type = 'application/json', origin = `http://127.0.0.1:${viewer.port}` } = {}) {
  return new Promise((resolve, reject) => {
    const headers = body === undefined ? {} : { 'Content-Type': type, ...(origin ? { Origin: origin } : {}) };
    const req = request({ host: '127.0.0.1', port: viewer.port, path, method: body === undefined ? method : 'POST', headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body === undefined || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  });
}
const paste = (viewer, type, bytes, origin) => send(viewer, route(viewer, 'image'), { body: bytes, type, origin });
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
  const image = await send(viewer, route(viewer, 'images/img/a%20b.png'));
  assert.equal(image.status, 200);
  assert.equal(image.headers['content-type'], 'image/png');
  assert.ok(image.body.equals(PNG));
  assert.match(image.headers['content-security-policy'], /^sandbox;/);
  // Queries do not change the granted file.
  assert.ok((await send(viewer, route(viewer, 'images/img/a%20b.png?v=2'))).body.equals(PNG));
  assert.equal((await send(viewer, route(viewer, 'images/secret.txt'))).status, 404);
  // URL parsing removes a literal `..`; an encoded slash reaches the segment check.
  assert.equal((await send(viewer, route(viewer, 'images/../outside.png'))).status, 404);
  assert.equal((await send(viewer, route(viewer, 'images/..%2Foutside.png'))).status, 403);
  await symlink(join(root, 'outside.png'), join(docs, 'escape.png'));
  assert.equal((await send(viewer, route(viewer, 'images/escape.png'))).status, 404);
  await symlink(join(docs, 'img', 'a b.png'), join(docs, 'alias.png'));
  assert.equal((await send(viewer, route(viewer, 'images/alias.png'))).status, 200);
  // The opened document stays under its own route; other text keeps its one-file grant.
  assert.equal((await send(viewer, route(viewer, 'file/doc.md'))).status, 200);
  const notes = await start('notes.txt', 'plain');
  assert.equal((await send(notes, route(notes, 'images/img/a%20b.png'))).status, 404);
});

test('never follows an image symlink, or a folder link, to a share', { skip: process.platform === 'win32' }, async () => {
  // POSIX reads `//<docs>/img` as `<docs>/img`, inside the grant, so only the
  // refusal keeps these from being served or renamed.
  await symlink(`/${join(docs, 'img', 'a b.png')}`, join(docs, 'share.png'));
  await symlink(`/${join(docs, 'img')}`, join(docs, 'share-img'));
  const viewer = await start();
  assert.equal((await send(viewer, route(viewer, 'images/share.png'))).status, 404);
  assert.equal((await send(viewer, route(viewer, 'images/share-img/a%20b.png'))).status, 404);
  assert.equal((await rename(viewer, 'share-img/a b.png', 'share-img/moved.png')).status, 404);
  assert.deepEqual(await readdir(join(docs, 'img')), ['a b.png']);
});

test('an image path resolves under its folder, and on Windows never through a drive or stream colon', () => {
  assert.equal(resolveInside('/docs', ['img', 'a:b.png'], posix), '/docs/img/a:b.png');
  assert.equal(resolveInside('C:\\docs', ['img', 'a.png'], win32), 'C:\\docs\\img\\a.png');
  assert.equal(resolveInside('C:\\docs', ['D:a.png'], win32), null);
  assert.equal(resolveInside('C:\\docs', ['img', 'a.png:hidden'], win32), null);
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
  assert.match((await paste(viewer, 'image/jpeg', PNG)).body.toString(), /not a JPEG image/);
  assert.equal((await paste(viewer, 'constructor', PNG)).status, 415);
  // A CORS-safelisted type is one a foreign page could send unpreflighted.
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) assert.equal((await paste(viewer, type, PNG)).status, 415, type);
  const notes = await start('notes.txt', 'plain');
  assert.equal((await paste(notes, 'image/png', PNG)).status, 404);
});

test('a paste answers the width the page inserts its image at, read past any amount of header', async () => {
  const viewer = await start();
  const answer = async (type, bytes) => JSON.parse((await paste(viewer, type, bytes)).body);
  assert.equal((await answer('image/png', PNG)).width, null, 'pixel for pixel');
  // A 144 dpi (2x) JPEG 1200 pixels wide, its frame header behind 128 KiB of ICC.
  const segment = (marker, data) => Buffer.concat([Buffer.from([0xff, marker, (data.length + 2) >> 8, (data.length + 2) & 0xff]), data]);
  const icc = segment(0xe2, Buffer.alloc(0xffff - 2));
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from([...Buffer.from('JFIF\0'), 1, 1, 1, 0, 144, 0, 144, 0, 0])),
    icc, icc,
    segment(0xc0, Buffer.from([8, 800 >> 8, 800 & 0xff, 1200 >> 8, 1200 & 0xff, 1, 1, 0x11, 0])),
    Buffer.from([0xff, 0xda]),
  ]);
  const { name, width } = await answer('image/jpeg', jpeg);
  assert.match(name, /\.jpg$/);
  assert.equal(width, 600);
});

test('a paste never replaces an existing file', async () => {
  const now = new Date(2026, 9, 2, 13, 4, 5);
  await writeFile(join(docs, 'image-20261002-130405.png'), 'existing');
  assert.equal(await pasteImage(editorStore(docs), 'image/png', PNG, now), 'image-20261002-130405-2.png');
  assert.equal(await pasteImage(editorStore(docs), 'image/jpeg', JPEG, now), 'image-20261002-130405.jpg');
  assert.equal(await readFile(join(docs, 'image-20261002-130405.png'), 'utf8'), 'existing');
});

test('image renames stay in their folder, keep an image name, and never replace a file', { skip: process.platform === 'win32' }, async () => {
  const viewer = await start();
  await writeFile(join(docs, 'img', 'taken.png'), PNG);
  assert.equal((await rename(viewer, 'img/a b.png', 'img/taken.png')).status, 409);
  assert.equal((await send(viewer, route(viewer, 'rename'), { body: { from: 'img/a b.png', to: 'img/c.png' }, type: 'text/plain' })).status, 415);
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

test('the Markdown editor has no route that replaces an image\'s bytes', async () => {
  const viewer = await start();
  assert.equal((await send(viewer, route(viewer, 'edit/img/a%20b.png'))).status, 404);
  assert.equal((await send(viewer, route(viewer, 'image-save/img/a%20b.png?version=x'), { body: JPEG, type: 'image/jpeg' })).status, 404);
  assert.ok((await readFile(join(docs, 'img', 'a b.png'))).equals(PNG));
});

test('navigation emits a resolved open request without granting the destination to this viewer', async () => {
  const opened = [];
  await writeFile(join(docs, 'links.md'), '# Links');
  const viewer = await startFileViewer(join(docs, 'links.md'), { onOpen: value => opened.push(value) });
  viewers.push(viewer);
  const open = (href, disposition = 'current', options = {}) => send(viewer, route(viewer, 'open'), { body: { href, disposition }, ...options });
  assert.equal((await open('../other%20file.md?x=1#details')).status, 200);
  assert.deepEqual(opened.at(-1), { path: join(root, 'other file.md'), preview: false, disposition: 'current', fragment: 'details' });
  assert.equal((await open('#top', 'other')).status, 200);
  assert.equal(opened.at(-1).path, join(docs, 'links.md'));
  assert.equal(opened.at(-1).disposition, 'other');
  for (const href of ['/absolute.md', 'file:///absolute.md', 'https://example.test', 'bad%00.md']) assert.equal((await open(href)).status, 400);
  assert.equal((await open('a.md', 'fresh')).status, 400);
  assert.equal((await open('a.md', 'current', { origin: 'https://elsewhere.test' })).status, 403);
  assert.equal((await open('a.md', 'current', { type: 'text/plain' })).status, 415);
  assert.equal((await open('x'.repeat(9000))).status, 413);
  assert.equal((await send(viewer, route(viewer, 'file/secret.txt'))).status, 404);
  for (const disposition of ['current', 'other']) {
    assert.equal((await open('img/a%20%25%23%3F.png', disposition)).status, 200);
    assert.deepEqual(opened.at(-1), { path: join(docs, 'img', 'a %#?.png'), preview: false, disposition, fragment: undefined });
  }
  assert.equal(opened.length, 4);
});
