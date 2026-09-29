import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, test } from 'node:test';
import { startFolderViewer } from '../dist/folder-viewer.js';

const require = createRequire(import.meta.url);
const { createDorControlServer } = require('../../standalone/sidecar/dor-control-server.js');

const posixOnly = { skip: process.platform === 'win32' ? 'POSIX file names, symlinks, and sockets' : false };
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

test('caps one directory at 5,000 entries', async () => {
  await Promise.all(Array.from({ length: 5001 }, (_, i) => writeFile(join(root, `f${i}`), '')));
  const listing = await list(await start());
  assert.equal(listing.entries.length, 5000);
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

async function spawnViewer(env) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/dor.js', import.meta.url)), '__view-folder', root], { stdio: ['ignore', 'pipe', 'pipe'], env });
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
  return { child, viewer: announce };
}
function withoutControl() {
  const env = { ...process.env };
  for (const key of ['DORMOUSE_CONTROL_SOCKET', 'DORMOUSE_CONTROL_TOKEN', 'DORMOUSE_SURFACE_ID']) delete env[key];
  return env;
}

test('the bundled private entry announces its port and path, then exits on termination', { timeout: 10_000 }, async () => {
  await files({ 'a.txt': 'a' });
  const { child, viewer } = await spawnViewer(withoutControl());
  try {
    assert.equal(viewer.v, 1);
    assert.deepEqual((await list(viewer)).entries, [entry('a.txt', 'file')]);
    assert.deepEqual(JSON.parse((await post(viewer, 'select', { path: 'a.txt' })).body), { ok: false, error: 'Dormouse control endpoint is not available in this terminal yet.' });
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
    await assert.rejects(call(viewer, viewer.path));
  } finally { child.kill('SIGKILL'); }
});

test('the private entry opens through the control socket as dor open --preview', { ...posixOnly, timeout: 10_000 }, async () => {
  await files({ 'a.txt': 'a' });
  const socketPath = join(base, 'control.sock');
  const requests = [];
  const server = createDorControlServer({
    socketPath,
    token: 'shared-secret',
    send(event, data) {
      if (event !== 'dor:controlRequest') return;
      requests.push(data);
      server.respond(data.params.preview
        ? { requestId: data.requestId, ok: true, result: { status: 'superseded' } }
        : { requestId: data.requestId, ok: false, error: 'no Tool matches a.txt' });
    },
  });
  await server.ready;
  const { child, viewer } = await spawnViewer({ ...withoutControl(), DORMOUSE_CONTROL_SOCKET: socketPath, DORMOUSE_CONTROL_TOKEN: 'shared-secret', DORMOUSE_SURFACE_ID: 'folder-1' });
  try {
    assert.deepEqual(JSON.parse((await post(viewer, 'select', { path: 'a.txt' })).body), { ok: true, status: 'superseded' });
    assert.deepEqual(JSON.parse((await post(viewer, 'activate', { path: 'a.txt' })).body), { ok: false, error: 'no Tool matches a.txt' });
    assert.deepEqual(requests.map(r => [r.method, r.surfaceId, r.params]), [
      ['surface.tool', 'folder-1', { file: join(root, 'a.txt'), preview: true, cwd: root, fresh: false, minimized: false }],
      ['surface.tool', 'folder-1', { file: join(root, 'a.txt'), preview: false, cwd: root, fresh: false, minimized: false }],
    ]);
  } finally {
    child.kill('SIGKILL');
    server.close();
  }
});
