import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { stopRelay } from './spawn-relay.mjs';

const relay = fileURLToPath(new URL('..', import.meta.url));

// Copy the real dev entrypoint into independent worktrees; the built runtime
// is read-only and shared. No Relay sockets or state stores are substituted.
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-dev-'));
  const dir = path.join(root, 'relay');
  await mkdir(path.join(dir, 'scripts'), { recursive: true });
  await copyFile(path.join(relay, 'scripts/dev.mjs'), path.join(dir, 'scripts/dev.mjs'));
  await symlink(path.join(relay, 'dist'), path.join(dir, 'dist'), 'junction');
  const children = [];
  t.after(async () => {
    await Promise.all(children.map(stopRelay));
    await rm(root, { recursive: true, force: true });
  });
  return {
    dir,
    start(overrides = {}, production = false) {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        key !== 'PORT' && !key.startsWith('DORMOUSE_')));
      const child = spawn(process.execPath, [path.join(dir, production ? 'dist/index.js' : 'scripts/dev.mjs')], {
        cwd: root, env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(child);
      let output = '';
      let readyResolve;
      let readyReject;
      const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      // Failure cases await `exited` instead.
      ready.catch(() => {});
      const timer = setTimeout(() => readyReject(new Error(`no listener: ${output}`)), 15000);
      const consume = chunk => {
        output += chunk;
        const match = output.match(/relay listening on (http:\/\/\S+) \(origin (\S+)\)/);
        if (match) { clearTimeout(timer); readyResolve({ url: match[1], origin: match[2] }); }
      };
      child.stdout.on('data', consume);
      child.stderr.on('data', consume);
      const exited = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => {
          clearTimeout(timer);
          readyReject(new Error(`Relay exited ${code}: ${output}`));
          resolve(code);
        });
      });
      return { child, ready, exited, get output() { return output; }, stop: () => stopRelay(child) };
    },
  };
}

async function password(dir) {
  return JSON.parse(await readFile(path.join(dir, 'setup-password.json'), 'utf8')).password;
}

async function enroll(url, setupPassword) {
  return fetch(`${url}/api/burrow/enroll`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: setupPassword, name: 'dev fixture' }),
  });
}

test('parallel dev worktrees have distinct listeners and persistent state, with the bound origin in enrollment', async t => {
  const [a, b] = await Promise.all([fixture(t), fixture(t)]);
  const one = a.start();
  const two = b.start({ PORT: '0' });
  const [first, second] = await Promise.all([one.ready, two.ready]);
  assert.notEqual(first.url, second.url);
  const [keyA, keyB] = await Promise.all([password(path.join(a.dir, 'data')), password(path.join(b.dir, 'data'))]);
  assert.notEqual(keyA, keyB);
  for (const [run, key] of [[first, keyA], [second, keyB]]) {
    assert.equal(run.origin, run.url.replace('127.0.0.1', 'localhost'));
    const response = await enroll(run.url, key);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.origin, run.origin);
    assert.equal(body.rpId, 'localhost');
  }
  assert.equal((await enroll(second.url, keyA)).status, 401);
  await one.stop();
  await assert.rejects(fetch(first.url));
  assert.equal((await fetch(`${second.url}/api/hello`)).status, 200);
  const restarted = a.start();
  await restarted.ready;
  assert.equal(await password(path.join(a.dir, 'data')), keyA);
});

test('dev honors explicit ports/origins/state and refuses an occupied port without touching its owner', async t => {
  const [a, b] = await Promise.all([fixture(t), fixture(t)]);
  const one = a.start();
  const first = await one.ready;
  const port = new URL(first.url).port;
  const collision = b.start({ PORT: port });
  assert.equal(await collision.exited, 1);
  assert.match(collision.output, /EADDRINUSE/);
  assert.equal((await fetch(`${first.url}/api/hello`)).status, 200);
  await one.stop();
  const stateDir = path.join(b.dir, 'custom-state');
  const custom = b.start({ PORT: port, DORMOUSE_STATE_DIR: stateDir, DORMOUSE_ORIGIN: 'https://dev.example.test/' });
  const listening = await custom.ready;
  assert.equal(new URL(listening.url).port, port);
  assert.equal(listening.origin, 'https://dev.example.test');
  const response = await enroll(listening.url, await password(stateDir));
  assert.equal((await response.json()).origin, listening.origin);
});

test('production still rejects PORT=0 before creating state', async t => {
  const a = await fixture(t);
  const stateDir = path.join(a.dir, 'production-state');
  const run = a.start({ PORT: '0', DORMOUSE_STATE_DIR: stateDir }, true);
  assert.equal(await run.exited, 1);
  assert.match(run.output, /PORT must be an integer between 1 and 65535/);
  await assert.rejects(readFile(path.join(stateDir, 'setup-password.json')), { code: 'ENOENT' });
});
