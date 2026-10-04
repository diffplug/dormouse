import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { request } from 'node:http';
import { afterEach, beforeEach, test } from 'node:test';
import { startFileViewer } from '../dist/file-viewer.js';
import { editorStore } from '../dist/editor-store.js';
import { NOT_IN_PLACE_MESSAGE, pasteImage } from '../dist/editor-routes.js';
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
  // The page's cache-busting query after an image save names the same file.
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
  const notes = await start('notes.txt', 'plain');
  assert.equal((await paste(notes, 'image/png', PNG)).status, 404);
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

const EDITED = Buffer.concat([PNG, Buffer.from('edited')]);
const edit = (viewer, path) => send(viewer, route(viewer, `edit/${path}`));
const saveImage = (viewer, path, version, bytes = EDITED, type = 'image/png', origin) =>
  send(viewer, route(viewer, `image-save/${path}?version=${version}`), { body: bytes, type, origin });

test('a PNG or JPEG at or under the document folder is replaced in place at its revision', async () => {
  const viewer = await start();
  const opened = await edit(viewer, 'img/a%20b.png');
  assert.equal(opened.status, 200);
  assert.equal(opened.headers['content-type'], 'image/png');
  assert.match(opened.headers['content-security-policy'], /^sandbox;/);
  assert.ok(opened.body.equals(PNG));
  const version = opened.headers['x-dor-version'];
  for (const origin of ['', 'null', 'https://elsewhere.test']) assert.equal((await saveImage(viewer, 'img/a%20b.png', version, EDITED, 'image/png', origin)).status, 403);
  assert.equal((await saveImage(viewer, 'img/a%20b.png', '')).status, 400);
  assert.equal((await saveImage(viewer, 'img/a%20b.png', version, JPEG)).status, 415);
  assert.equal((await saveImage(viewer, 'img/a%20b.png', version, EDITED, 'image/jpeg')).status, 415);
  const saved = await saveImage(viewer, 'img/a%20b.png', version);
  assert.equal(saved.status, 200, saved.body.toString());
  assert.ok((await readFile(join(docs, 'img', 'a b.png'))).equals(EDITED));
  assert.equal((await edit(viewer, 'img/a%20b.png')).headers['x-dor-version'], JSON.parse(saved.body).version);
  assert.equal((await saveImage(viewer, 'img/a%20b.png', version)).status, 409);
  assert.ok((await readFile(join(docs, 'img', 'a b.png'))).equals(EDITED));
  await writeFile(join(docs, 'photo.jpeg'), JPEG);
  const photo = await edit(viewer, 'photo.jpeg');
  assert.equal(photo.headers['content-type'], 'image/jpeg');
  const jpeg = Buffer.concat([JPEG, Buffer.from('edited')]);
  assert.equal((await saveImage(viewer, 'photo.jpeg', photo.headers['x-dor-version'], jpeg, 'image/jpeg')).status, 200);
  assert.ok((await readFile(join(docs, 'photo.jpeg'))).equals(jpeg));
  const notes = await start('notes.txt', 'plain');
  assert.equal((await edit(notes, 'img/a%20b.png')).status, 404);
  assert.equal((await saveImage(notes, 'img/a%20b.png', version)).status, 404);
});

test('in-place image saves refuse other formats, oversize bodies, and paths leaving the folder', async () => {
  const viewer = await start();
  const version = (await edit(viewer, 'img/a%20b.png')).headers['x-dor-version'];
  for (const name of ['anim.gif', 'photo.webp']) {
    await writeFile(join(docs, name), 'image');
    assert.equal((await edit(viewer, name)).status, 415);
    assert.equal((await saveImage(viewer, name, version)).status, 415);
    assert.equal(await readFile(join(docs, name), 'utf8'), 'image');
  }
  assert.equal((await edit(viewer, 'secret.txt')).status, 404);
  assert.equal((await edit(viewer, 'missing.png')).status, 404);
  assert.equal((await edit(viewer, '../outside.png')).status, 404);
  assert.equal((await saveImage(viewer, '..%2Foutside.png', version)).status, 403);
  assert.ok((await readFile(join(root, 'outside.png'))).equals(PNG));
  const large = Buffer.concat([PNG, Buffer.alloc(32 * 1024 * 1024)]);
  assert.equal((await saveImage(viewer, 'img/a%20b.png', version, large)).status, 413);
  assert.ok((await readFile(join(docs, 'img', 'a b.png'))).equals(PNG));
});

test('in-place image saves follow no symlink, to the image or to a folder above it', { skip: process.platform === 'win32' }, async () => {
  const viewer = await start();
  const version = (await edit(viewer, 'img/a%20b.png')).headers['x-dor-version'];
  await symlink(join(docs, 'img', 'a b.png'), join(docs, 'alias.png'));
  await symlink(join(docs, 'img'), join(docs, 'linked'));
  await symlink(join(root, 'outside.png'), join(docs, 'escape.png'));
  for (const path of ['alias.png', 'linked/a%20b.png']) {
    // The overlay shows it view-only, with why.
    const opened = await edit(viewer, path);
    assert.equal(opened.status, 200, path);
    assert.deepEqual(JSON.parse(opened.body), { viewOnly: NOT_IN_PLACE_MESSAGE }, path);
    const saved = await saveImage(viewer, path, version);
    assert.equal(saved.status, 404, path);
    assert.equal(saved.body.toString(), NOT_IN_PLACE_MESSAGE, path);
  }
  // A symlink leaving the folder grants nothing.
  assert.equal((await edit(viewer, 'escape.png')).status, 404);
  assert.equal((await saveImage(viewer, 'escape.png', version)).status, 404);
  const missing = await edit(viewer, 'missing.png');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.toString(), '');
  // Reads still follow a symlink that stays inside the folder.
  assert.equal((await send(viewer, route(viewer, 'images/alias.png'))).status, 200);
  assert.ok((await readFile(join(docs, 'img', 'a b.png'))).equals(PNG));
  assert.ok((await readFile(join(root, 'outside.png'))).equals(PNG));
});

test('an image spelled differently from the file on disk is not edited in place', async t => {
  if (!await realpath(join(docs, 'img', 'A B.png')).then(() => true, () => false)) { t.skip('case-sensitive volume'); return; }
  const viewer = await start();
  const opened = await edit(viewer, 'img/A%20B.png');
  assert.equal(opened.status, 200);
  assert.deepEqual(JSON.parse(opened.body), { viewOnly: NOT_IN_PLACE_MESSAGE });
  assert.equal((await saveImage(viewer, 'img/A%20B.png', 'x')).status, 404);
  assert.ok((await readFile(join(docs, 'img', 'a b.png'))).equals(PNG));
});

test('an image past the editor\'s byte or pixel bound opens view-only in the overlay, with why', async () => {
  const viewer = await start();
  // A header declaring 9000 × 9000 pixels; no pixel data follows.
  const huge = Buffer.from(PNG);
  huge.writeUInt32BE(9000, 16);
  huge.writeUInt32BE(9000, 20);
  await writeFile(join(docs, 'huge.png'), huge);
  await writeFile(join(docs, 'heavy.png'), Buffer.concat([PNG, Buffer.alloc(32 * 1024 * 1024)]));
  for (const [path, reason] of [['huge.png', /9000 × 9000 pixels/], ['heavy.png', /32 MiB/]]) {
    const opened = await edit(viewer, path);
    assert.equal(opened.status, 200, path);
    assert.equal(opened.headers['content-type'], 'application/json', path);
    assert.match(JSON.parse(opened.body).viewOnly, reason, path);
    assert.equal((await send(viewer, route(viewer, `images/${path}`))).status, 200, path);
  }
});
