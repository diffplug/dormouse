import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { stageDorCli } from '../../scripts/stage-dor-cli.mjs';

// The `dor __view-*` private entries that run dor-tools-builtin's viewers
// (docs/specs/dor-tools-builtin.md); the viewers themselves are tested there.
// One staged CLI, outside the workspace, serves every test that leaves it intact.
let staged;
let cli;
let base;
let root;
async function stage(dir) {
  await stageDorCli(dir);
  return join(dir, 'dist', 'dor.js');
}
before(async () => {
  staged = await mkdtemp(join(tmpdir(), 'dor-builtin-cli-'));
  cli = await stage(staged);
});
after(async () => { await rm(staged, { recursive: true, force: true }); });
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
async function spawnViewer(verb, target, env = withoutControl(), extra = []) {
  const child = spawn(process.execPath, [cli, verb, target, ...extra], { stdio: ['ignore', 'pipe', 'pipe'], env, cwd: root });
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
  return { child, viewer, output, read: () => output };
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
    // The separately staged runtime reads its assets beside itself.
    const prefix = viewer.path.replace(/view$/, '');
    for (const name of ['editor.js', 'editor.css', 'editor.worker.js']) {
      assert.equal((await call(viewer, `${prefix}assets/${name}`)).status, 200, name);
    }
    await terminates(child, viewer);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
});

test('ordinary staged CLI commands work without the builtin runtime', async () => {
  // This must remain independent of both workspace packages and viewer code.
  const cli = await stage(join(base, 'dor-cli'));
  await rm(join(base, 'dor-cli', 'dist', 'builtin'), { recursive: true });
  const result = spawnSync(process.execPath, [cli, 'version'], { env: withoutControl(), cwd: root, timeout: 10_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, String(result.stderr));
  assert.match(String(result.stdout), /^dor /m);
  const viewer = spawnSync(process.execPath, [cli, '__view-file', join(root, 'missing.txt')], { env: withoutControl(), cwd: root, timeout: 10_000 });
  assert.equal(viewer.status, 1);
  assert.match(String(viewer.stderr), /runtime\.js/);
});

test('the folder entry titles itself, announces its port and path, then exits on termination', { timeout: 10_000 }, async () => {
  await writeFile(join(root, 'a.txt'), 'a');
  const { child, viewer, output } = await spawnViewer('__view-folder', root);
  try {
    assert.ok(output.includes('\x1b]2;root\x07'), JSON.stringify(output));
    assert.equal(viewer.v, 1);
    assert.deepEqual(JSON.parse((await call(viewer, `${viewer.path}list?dir=`)).body).entries, [{ name: 'a.txt', kind: 'file', ignored: false }]);
    await terminates(child, viewer);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
});

test('the folder entry selects and activates with OSC 367 open, in the order the page sends them', { timeout: 10_000 }, async () => {
  await writeFile(join(root, 'a.txt'), 'a');
  const { child, viewer, read } = await spawnViewer('__view-folder', root);
  try {
    assert.deepEqual(JSON.parse((await post(viewer, 'select', { path: 'a.txt' })).body), { ok: true, status: 'sent' });
    assert.deepEqual(JSON.parse((await post(viewer, 'activate', { path: 'a.txt' })).body), { ok: true, status: 'sent' });
    const file = join(root, 'a.txt');
    // stdout and the HTTP reply travel separately; wait for both requests to arrive.
    const opens = () => [...read().matchAll(/\x1b\]367;open;(\{[^\x07]*\})\x07/g)].map(match => JSON.parse(match[1]));
    for (let tries = 0; opens().length < 2 && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(opens(), [
      { v: 1, path: file, preview: true },
      { v: 1, path: file, preview: false },
    ]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
});

test('the error entry titles itself after its target and serves the escaped message', { timeout: 10_000 }, async () => {
  const { child, viewer, output } = await spawnViewer('__view-error', join(root, 'report.pdf'), withoutControl(), ['no Tool matches <report.pdf>']);
  try {
    assert.ok(output.includes('\x1b]2;report.pdf\x07'), JSON.stringify(output));
    const page = await call(viewer, viewer.path);
    assert.equal(page.status, 200);
    assert.match(page.body, /Can't show report\.pdf/);
    assert.match(page.body, /no Tool matches &lt;report\.pdf&gt;/);
    assert.equal((await call(viewer, `${viewer.path}anything`)).status, 404);
    await terminates(child, viewer);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
});
