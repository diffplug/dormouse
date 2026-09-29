import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, test } from 'node:test';

// The `dor __view-*` private entries that run dor-tools-builtin's viewers
// (docs/specs/dor-tools-builtin.md); the viewers themselves are tested there.
const require = createRequire(import.meta.url);
const { createDorControlServer } = require('../../standalone/sidecar/dor-control-server.js');

const posixOnly = { skip: process.platform === 'win32' ? 'POSIX sockets' : false };

let base;
let root;
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'dor-builtin-')));
  root = join(base, 'root');
  await mkdir(root);
});
afterEach(async () => { await rm(base, { recursive: true, force: true }); });

function call(viewer, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: viewer.port, path, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
function post(viewer, action, body) {
  return call(viewer, `${viewer.path}${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${viewer.port}` },
    body: JSON.stringify(body),
  });
}
async function spawnViewer(verb, target, env = withoutControl()) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/dor.js', import.meta.url)), verb, target], { stdio: ['ignore', 'pipe', 'pipe'], env });
  let output = '';
  const viewer = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`viewer exited early: ${code}`)));
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = /\x1b\]367;serve;(\{[^\x07]*\})\x07/.exec(output);
      if (match) resolve(JSON.parse(match[1]));
    });
  });
  return { child, viewer, output };
}
function withoutControl() {
  const env = { ...process.env };
  for (const key of ['DORMOUSE_CONTROL_SOCKET', 'DORMOUSE_CONTROL_TOKEN', 'DORMOUSE_SURFACE_ID']) delete env[key];
  return env;
}
async function terminates(child, viewer) {
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
  await assert.rejects(call(viewer, viewer.path));
}

test('the file entry titles itself, announces its port and path, serves the staged editor, then exits on termination', { timeout: 10_000 }, async () => {
  const file = join(root, 'cli.txt');
  await writeFile(file, 'cli preview');
  const { child, viewer, output } = await spawnViewer('__view-file', file);
  try {
    assert.ok(output.includes('\x1b]2;cli.txt\x07'), JSON.stringify(output));
    assert.equal((await call(viewer, viewer.path)).status, 200);
    // The bundle reads its assets beside itself, staged from dor-tools-builtin.
    const prefix = viewer.path.replace(/view$/, '');
    for (const name of ['editor.js', 'editor.css', 'editor.worker.js']) {
      assert.equal((await call(viewer, `${prefix}assets/${name}`)).status, 200, name);
    }
    await terminates(child, viewer);
  } finally { child.kill('SIGKILL'); }
});

test('the folder entry titles itself, announces its port and path, then exits on termination', { timeout: 10_000 }, async () => {
  await writeFile(join(root, 'a.txt'), 'a');
  const { child, viewer, output } = await spawnViewer('__view-folder', root);
  try {
    assert.ok(output.includes('\x1b]2;root\x07'), JSON.stringify(output));
    assert.equal(viewer.v, 1);
    assert.deepEqual(JSON.parse((await call(viewer, `${viewer.path}list?dir=`)).body).entries, [{ name: 'a.txt', kind: 'file', ignored: false }]);
    assert.deepEqual(JSON.parse((await post(viewer, 'select', { path: 'a.txt' })).body), { ok: false, error: 'Dormouse control endpoint is not available in this terminal yet.' });
    await terminates(child, viewer);
  } finally { child.kill('SIGKILL'); }
});

test('the folder entry opens through the control socket as dor open --preview', { ...posixOnly, timeout: 10_000 }, async () => {
  await writeFile(join(root, 'a.txt'), 'a');
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
  const { child, viewer } = await spawnViewer('__view-folder', root, { ...withoutControl(), DORMOUSE_CONTROL_SOCKET: socketPath, DORMOUSE_CONTROL_TOKEN: 'shared-secret', DORMOUSE_SURFACE_ID: 'folder-1' });
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
