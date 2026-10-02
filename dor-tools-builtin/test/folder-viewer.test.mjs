import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, test } from 'node:test';
import { oscOpen, startFolderViewer } from '../dist/folder-viewer.js';
import { folderViewerPage } from '../dist/folder-viewer-page.js';

const posixOnly = { skip: process.platform === 'win32' ? 'POSIX file names and symlinks' : false };
const hasGit = spawnSync('git', ['--version']).status === 0;
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'";

let base;
let root;
let opened;
const viewers = [];
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'dor-folder-')));
  root = join(base, 'root');
  await mkdir(root);
  opened = [];
});
afterEach(async () => {
  await Promise.all(viewers.splice(0).map(v => v.close()));
  await rm(base, { recursive: true, force: true });
});

async function start(result = { ok: true, status: 'created' }, dir = root) {
  const viewer = await startFolderViewer(dir, { open: async (path, preview) => { opened.push({ path, preview }); return result; } });
  viewers.push(viewer);
  return viewer;
}
async function files(entries) {
  for (const [name, contents] of Object.entries(entries)) {
    if (contents === null) await mkdir(join(root, name), { recursive: true });
    else await writeFile(join(root, name), contents);
  }
}
function call(viewer, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: viewer.port, path, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const own = viewer => `http://127.0.0.1:${viewer.port}`;
function post(viewer, action, body, headers = {}) {
  return call(viewer, `${viewer.path}${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: own(viewer), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
async function list(viewer, dir = '') {
  const response = await call(viewer, `${viewer.path}list?dir=${encodeURIComponent(dir)}`);
  return response.status === 200 ? { ...response, ...JSON.parse(response.body) } : response;
}
const entry = (name, kind, ignored = false) => ({ name, kind, ignored });

test('serves its page under the capability with the viewer policy, to its own Host and Origin only', async () => {
  const viewer = await start();
  const page = await call(viewer, viewer.path);
  assert.equal(page.status, 200);
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(page.headers['content-security-policy'], CSP);
  assert.equal(page.headers['x-dormouse-preserve-csp'], '1');
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.match(page.body, /role="tree"/);
  assert.equal((await list(viewer)).headers['content-security-policy'], CSP);

  const token = viewer.path.slice(1, -1);
  for (const path of ['/', '/list', `/${token.slice(1)}/`, `/${token}0/`, `/${token.slice(0, -1)}${token.at(-1) === '0' ? '1' : '0'}/list`]) {
    assert.equal((await call(viewer, path)).status, 403, path);
  }
  assert.equal((await call(viewer, viewer.path, { headers: { Host: `evil.test:${viewer.port}` } })).status, 403);
  assert.equal((await call(viewer, viewer.path, { headers: { Host: `LOCALHOST:${viewer.port}` } })).status, 200);
  assert.equal((await call(viewer, viewer.path, { headers: { Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await call(viewer, viewer.path, { headers: { Origin: own(viewer) } })).status, 200);
  assert.equal((await call(viewer, viewer.path, { method: 'PUT', headers: { Origin: own(viewer) } })).status, 403);
  const second = await start();
  assert.notEqual(second.path, viewer.path);
  assert.equal((await call(second, viewer.path)).status, 403);
});

test('escapes the root folder name into the page', posixOnly, async () => {
  const odd = join(base, '<b>"x"&');
  await mkdir(odd);
  const viewer = await start(undefined, odd);
  const page = await call(viewer, viewer.path);
  assert.ok(!page.body.includes('<b>"x"'));
  assert.match(page.body, /<title>&lt;b&gt;&quot;x&quot;&amp;<\/title>/);
});

test('a POST needs its own Origin, JSON, and a bounded body', async () => {
  await files({ 'a.txt': 'a' });
  const viewer = await start();
  for (const origin of [undefined, 'null', 'https://evil.test', `http://127.0.0.1:${viewer.port + 1}`]) {
    const headers = { 'Content-Type': 'application/json', ...(origin === undefined ? {} : { Origin: origin }) };
    assert.equal((await call(viewer, `${viewer.path}select`, { method: 'POST', headers, body: '{"path":"a.txt"}' })).status, 403, String(origin));
  }
  assert.equal((await call(viewer, `${viewer.path}select`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: own(viewer), Host: `evil.test:${viewer.port}` }, body: '{"path":"a.txt"}' })).status, 403);
  assert.equal(opened.length, 0);

  assert.equal((await post(viewer, 'select', { path: 'a.txt' }, { Origin: `http://localhost:${viewer.port}` })).status, 200);
  assert.equal((await post(viewer, 'select', { path: 'a.txt' }, { 'Content-Type': 'application/json; charset=utf-8' })).status, 200);
  assert.equal(opened.length, 2);

  assert.equal((await post(viewer, 'select', { path: 'a.txt' }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post(viewer, 'select', '{"path":')).status, 400);
  assert.equal((await post(viewer, 'select', { file: 'a.txt' })).status, 400);
  const large = JSON.stringify({ path: 'a.txt', pad: 'x'.repeat(8 * 1024) });
  assert.equal((await post(viewer, 'select', large)).status, 413);
  assert.equal((await post(viewer, 'list', { path: 'a.txt' })).status, 404);
  assert.equal((await call(viewer, `${viewer.path}select`)).status, 404);
  assert.equal(opened.length, 2);
});

test('lists names and kinds only, directories first, dotfiles included, one directory at a time', async () => {
  await files({ 'b.txt': 'b', 'A.txt': 'a', '.env': 'e', '.config': null, sub: null, Zdir: null, 'sub/inner.txt': 'i', 'sub/deeper': null });
  const viewer = await start();
  const top = await list(viewer);
  assert.deepEqual(JSON.parse(top.body), {
    entries: [entry('.config', 'dir'), entry('sub', 'dir'), entry('Zdir', 'dir'), entry('.env', 'file'), entry('A.txt', 'file'), entry('b.txt', 'file')],
    truncated: false,
  });
  assert.equal(top.headers['content-type'], 'application/json');
  assert.deepEqual((await list(viewer, 'sub')).entries, [entry('deeper', 'dir'), entry('inner.txt', 'file')]);
  assert.deepEqual((await list(viewer, 'sub/deeper')).entries, []);
  assert.equal((await list(viewer, 'b.txt')).status, 404);
  assert.equal((await list(viewer, 'missing')).status, 404);
  assert.equal((await call(viewer, `${viewer.path}list`, { method: 'HEAD' })).body, '');
});

test('caps one directory at its first 5,000 entries in display order, directories first', async () => {
  const names = Array.from({ length: 5001 }, (_, i) => `f${i}`);
  await Promise.all(names.map(name => writeFile(join(root, name), '')));
  // Last by name, and wherever readdir puts them.
  await files({ zdir0: null, zdir1: null, zdir2: null });
  const listing = await list(await start());
  assert.deepEqual(listing.entries, [
    ...['zdir0', 'zdir1', 'zdir2'].map(name => entry(name, 'dir')),
    ...names.sort().slice(0, 4997).map(name => entry(name, 'file')),
  ]);
  assert.equal(listing.truncated, true);
});

test('refuses traversal spellings on list, select, and activate', async () => {
  await files({ sub: null, 'sub/a.txt': 'a' });
  await writeFile(join(base, 'outside.txt'), 'outside');
  const viewer = await start();
  for (const dir of ['..', '.', 'sub/..', '../root', 'sub/./a.txt', 'sub//a.txt', '/sub', 'sub/', 'sub\\a.txt', 'sub\u0001', 'sub\u009b', '../outside.txt']) {
    assert.equal((await list(viewer, dir)).status, 403, JSON.stringify(dir));
    for (const action of ['select', 'activate']) assert.equal((await post(viewer, action, { path: dir })).status, 403, `${action} ${JSON.stringify(dir)}`);
  }
  // Percent-encoded traversal decodes to the same refused spelling.
  assert.equal((await call(viewer, `${viewer.path}list?dir=%2e%2e`)).status, 403);
  assert.equal((await call(viewer, `${viewer.path}list?dir=sub%2f%2e%2e%2f%2e%2e`)).status, 403);
  assert.notEqual((await call(viewer, `${viewer.path}%2e%2e/list`)).status, 200);
  assert.equal(opened.length, 0);
});

test('a symlink leaving the root lists as other and can be neither listed nor opened', posixOnly, async () => {
  await mkdir(join(base, 'outside'));
  await writeFile(join(base, 'outside', 'secret.txt'), 'secret');
  await files({ sub: null, 'sub/a.txt': 'a' });
  await symlink(join(base, 'outside'), join(root, 'escape'));
  await symlink(join(base, 'outside', 'secret.txt'), join(root, 'leak.txt'));
  await symlink(join(root, 'sub'), join(root, 'inner'));
  await symlink(join(root, 'sub', 'a.txt'), join(root, 'alias.txt'));
  await symlink(join(root, 'missing'), join(root, 'broken'));
  const viewer = await start();
  assert.deepEqual((await list(viewer)).entries, [
    entry('inner', 'dir'), entry('sub', 'dir'), entry('alias.txt', 'file'), entry('broken', 'other'), entry('escape', 'other'), entry('leak.txt', 'other'),
  ]);
  assert.equal((await list(viewer, 'escape')).status, 403);
  assert.deepEqual((await list(viewer, 'inner')).entries, [entry('a.txt', 'file')]);
  for (const path of ['escape', 'escape/secret.txt', 'leak.txt']) assert.equal((await post(viewer, 'select', { path })).status, 403, path);
  assert.equal(opened.length, 0);
  assert.equal((await post(viewer, 'select', { path: 'alias.txt' })).status, 200);
  assert.deepEqual(opened, [{ path: join(root, 'sub', 'a.txt'), preview: true }]);
});

test('flags git-ignored entries without running the folder\'s fsmonitor', { skip: !hasGit ? 'git is not installed' : posixOnly.skip }, async () => {
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: root }).status, 0, args.join(' '));
  git('init', '-q', '.');
  // `:(glob)` would read as pathspec magic and fail the whole query unless each path is `./`-prefixed.
  await files({ '.gitignore': 'build/\ndist/\n*.log\n', build: null, 'build/out.js': '', dist: 'a file, not a dir', 'a.log': '', 'kept.log': '', 'keep.txt': '', ':(glob)b.log': '' });
  git('add', '-f', 'kept.log');
  const sentinel = join(base, 'fsmonitor-ran');
  const hook = join(base, 'fsmonitor.sh');
  await writeFile(hook, `#!/bin/sh\necho > '${sentinel}'\n`);
  await chmod(hook, 0o755);
  git('config', 'core.fsmonitor', hook);

  const viewer = await start();
  assert.deepEqual((await list(viewer)).entries, [
    entry('.git', 'dir'), entry('build', 'dir', true),
    entry('.gitignore', 'file'), entry(':(glob)b.log', 'file', true), entry('a.log', 'file', true), entry('dist', 'file'), entry('keep.txt', 'file'), entry('kept.log', 'file'),
  ]);
  assert.deepEqual((await list(viewer, 'build')).entries, [entry('out.js', 'file', true)]);
  assert.equal(existsSync(sentinel), false);
});

test('a failing or missing git flags nothing ignored and never fails the listing', posixOnly, async () => {
  await files({ 'a.log': '' });
  const bin = join(base, 'bin');
  await mkdir(bin);
  // Git exits 128 on a refused query, possibly after printing some answers.
  await writeFile(join(bin, 'git'), '#!/bin/sh\nprintf "./a.log\\0"\nexit 128\n');
  await chmod(join(bin, 'git'), 0o755);
  const path = process.env.PATH;
  try {
    for (const dirs of [bin, join(base, 'missing')]) {
      process.env.PATH = dirs; // resolved when the viewer starts
      assert.deepEqual((await list(await start())).entries, [entry('a.log', 'file')], dirs);
    }
  } finally { process.env.PATH = path; }
});

test('select and activate hand open the canonical path and reply with its result', async () => {
  await files({ sub: null, 'sub/a.txt': 'a' });
  const viewer = await start();
  assert.deepEqual(JSON.parse((await post(viewer, 'select', { path: 'sub/a.txt' })).body), { ok: true, status: 'created' });
  assert.deepEqual(JSON.parse((await post(viewer, 'activate', { path: 'sub/a.txt' })).body), { ok: true, status: 'created' });
  assert.equal((await post(viewer, 'select', { path: 'sub' })).status, 200);
  assert.deepEqual(opened, [
    { path: join(root, 'sub', 'a.txt'), preview: true },
    { path: join(root, 'sub', 'a.txt'), preview: false },
    { path: join(root, 'sub'), preview: true },
  ]);
  assert.equal((await post(viewer, 'select', { path: 'missing.txt' })).status, 404);
  assert.equal((await post(viewer, 'select', { path: '' })).status, 400);

  const failing = await start({ ok: false, error: 'no Tool matches a.txt' });
  assert.deepEqual(JSON.parse((await post(failing, 'activate', { path: 'sub/a.txt' })).body), { ok: false, error: 'no Tool matches a.txt' });
});

test('compacts directory-only chains, counting hidden and ignored files as siblings', async () => {
  await files({ 'src/main/java': null, 'src/main/java/A.java': 'class A {}',
    'with-file/child': null, 'with-file/.hidden': '',
    'empty/leaf': null, 'branch/left': null, 'branch/right': null });
  const viewer = await start();
  const names = (await list(viewer)).entries.map(row => row.name);
  assert.deepEqual(names, ['branch', 'empty/leaf', 'src/main/java', 'with-file']);
  assert.deepEqual((await list(viewer, 'src/main/java')).entries, [entry('A.java', 'file')]);
  assert.equal((await post(viewer, 'select', { path: 'src/main/java/A.java' })).status, 200);
  assert.equal(opened[0].path, join(root, 'src/main/java/A.java'));
});

test('no route returns file contents', async () => {
  await files({ 'secret.txt': 'TOPSECRET', sub: null, 'sub/nested.txt': 'TOPSECRET' });
  const viewer = await start();
  const paths = ['file/secret.txt', 'secret.txt', 'view', 'sub/nested.txt', 'list/secret.txt', 'list?dir=secret.txt', 'list?dir=sub/nested.txt', '%2e%2e/root/secret.txt'];
  for (const path of paths) {
    for (const method of ['GET', 'HEAD']) {
      const response = await call(viewer, `${viewer.path}${path}`, { method });
      assert.notEqual(response.status, 200, `${method} ${path}`);
      assert.ok(!response.body.includes('TOPSECRET'), `${method} ${path}`);
    }
  }
  for (const action of ['select', 'activate']) assert.ok(!(await post(viewer, action, { path: 'secret.txt' })).body.includes('TOPSECRET'));
});

/** Runs the page's script against a stub DOM whose root lists the files
 * `names`. Each POST it sends waits in `posts` until the test settles it. */
async function runPage(names) {
  class Element {
    constructor() { this.style = {}; this.classList = { toggle() {} }; this.handlers = {}; }
    setAttribute() {}
    removeAttribute() {}
    appendChild(child) { return child; }
    addEventListener(type, handler) { this.handlers[type] = handler; }
    scrollIntoView() {}
    closest() { return this; }
  }
  const elements = { tree: new Element(), show: new Element(), status: new Element(), refresh: new Element(), collapse: new Element() };
  const items = [];
  const document = {
    getElementById: id => elements[id],
    createElement: tag => { const element = new Element(); if (tag === 'li') items.push(element); return element; },
  };
  const answer = body => ({ ok: true, text: async () => JSON.stringify(body) });
  const posts = [];
  const fetch = (url, init) => init
    ? new Promise((resolve, reject) => posts.push({ sent: `${url} ${JSON.parse(init.body).path}`, ok: () => resolve(answer({ ok: true, status: 'created' })), fail: () => reject(new Error('lost')) }))
    : Promise.resolve(answer({ entries: names.map(name => entry(name, 'file')), truncated: false }));
  runInNewContext(/<script>([\s\S]*)<\/script>/.exec(folderViewerPage(root))[1], { document, fetch, setTimeout, clearTimeout });
  await settle();
  const tree = elements.tree.handlers;
  return {
    posts, sent: () => posts.map(post => post.sent),
    click: (name, detail = 1) => tree.click({ target: items[names.indexOf(name)], detail }),
    dblclick: name => tree.dblclick({ target: items[names.indexOf(name)] }),
    key: key => tree.keydown({ key, preventDefault() {} }),
  };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('the page sends an activate only once every select in flight has settled', async () => {
  const page = await runPage(['a.txt', 'b.txt']);
  page.click('a.txt');
  page.click('b.txt'); page.click('b.txt', 2); page.dblclick('b.txt');
  await settle();
  assert.deepEqual(page.sent(), ['select a.txt', 'select b.txt']); // selects stay concurrent
  page.posts[1].fail();
  await settle();
  assert.deepEqual(page.sent(), ['select a.txt', 'select b.txt']);
  page.posts[0].ok();
  await settle();
  assert.deepEqual(page.sent(), ['select a.txt', 'select b.txt', 'activate b.txt']);
});

test('the page\'s Enter waits for a select in flight as a double-click does', async () => {
  const page = await runPage(['a.txt']);
  page.click('a.txt');
  page.key('Enter');
  await settle();
  assert.deepEqual(page.sent(), ['select a.txt']);
  page.posts[0].ok();
  await settle();
  assert.deepEqual(page.sent(), ['select a.txt', 'activate a.txt']);
});

test('writes each open as OSC 367, and answers an error for a path the host would refuse', async () => {
  const written = [];
  const open = oscOpen(text => written.push(text));
  assert.deepEqual(await open('/x/a.txt', true), { ok: true, status: 'sent' });
  assert.equal(written.length, 1);
  assert.match(written[0], /^\u001b]367;open;/);
  for (const path of ['/x/line\nbreak.txt', '\\\\server\\share\\a.txt', '/' + 'a'.repeat(2048)]) {
    const result = await open(path, false);
    assert.equal(result.ok, false, path);
    assert.match(result.error, /^Cannot open /);
  }
  assert.equal(written.length, 1);
});


test('answers a page-visible error when JSON escaping makes an open payload too large', async () => {
  const written = [];
  const open = oscOpen(text => written.push(text));
  for (const path of ['/' + '"'.repeat(2047), 'C:' + '\\'.repeat(2046)]) {
    const result = await open(path, false);
    assert.equal(result.ok, false);
    assert.match(result.error, /^Cannot open /);
  }
  assert.deepEqual(written, []);
});
