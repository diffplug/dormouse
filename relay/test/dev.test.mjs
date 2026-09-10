import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { API_ROUTES } from 'remote-lib-common';

import { SetupPasswordStore } from '../dist/state.js';
import { stopRelay } from './spawn-relay.mjs';
import { runner } from '../../standalone/scripts/dev-fixture.mjs';

const relay = fileURLToPath(new URL('..', import.meta.url));

/** The developer's own Relay settings must not leak into a spawned run. */
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key !== 'PORT' && !key.startsWith('DORMOUSE_')),
);

const LISTENING = /relay listening on (http:\/\/\S+) \(origin (\S+)\)/;

// Copy the real dev entrypoint into independent worktrees; the built runtime
// is read-only and shared. No Relay sockets or state stores are substituted.
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-dev-'));
  const dir = path.join(root, 'relay');
  await mkdir(path.join(dir, 'scripts'), { recursive: true });
  await Promise.all([
    ...['dev.mjs', 'dev-paths.mjs'].map((file) =>
      copyFile(path.join(relay, 'scripts', file), path.join(dir, 'scripts', file)),
    ),
    symlink(path.join(relay, 'dist'), path.join(dir, 'dist'), 'junction'),
  ]);
  const children = [];
  t.after(async () => {
    await Promise.all(children.map(stopRelay));
    await rm(root, { recursive: true, force: true });
  });
  return {
    dir,
    /** `script` picks the entrypoint: the dev runner, or the production one. */
    start(overrides = {}, script = 'scripts/dev.mjs') {
      const child = spawn(process.execPath, [path.join(dir, script)], {
        cwd: root, env: { ...CLEAN_ENV, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(child);
      const run = runner(child, script);
      return {
        exited: run.exited,
        // A getter, not a spread: `output` grows for as long as the child runs.
        get output() { return run.output; },
        // The bound listener, as the run itself reported it.
        async listening() {
          const [, url, origin] = await run.wait(LISTENING);
          return { url, origin };
        },
        stop: () => stopRelay(child),
      };
    },
  };
}

// The store the Relay writes through, so the record's shape and its validity
// rule are read from the product rather than mirrored here.
async function password(stateDir) {
  return (await new SetupPasswordStore(stateDir).load())?.password;
}

async function enroll(url, setupPassword) {
  return fetch(`${url}${API_ROUTES.burrowEnroll}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: setupPassword, name: 'dev fixture' }),
  });
}

test('parallel dev worktrees have distinct listeners and persistent state, with the bound origin in enrollment', async t => {
  const [a, b] = await Promise.all([fixture(t), fixture(t)]);
  const one = a.start();
  const two = b.start({ PORT: '0' });
  const [first, second] = await Promise.all([one.listening(), two.listening()]);
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
  await a.start().listening();
  assert.equal(await password(path.join(a.dir, 'data')), keyA);
});

test('dev honors explicit ports/origins/state and refuses an occupied port without touching its owner', async t => {
  const [a, b] = await Promise.all([fixture(t), fixture(t)]);
  const one = a.start();
  const first = await one.listening();
  const port = new URL(first.url).port;
  const collision = b.start({ PORT: port });
  assert.equal((await collision.exited).code, 1);
  assert.match(collision.output, /EADDRINUSE/);
  assert.equal((await fetch(`${first.url}/api/hello`)).status, 200);
  await one.stop();
  // Preserve the path verbatim, including legal trailing spaces on POSIX.
  const stateDir = path.join(b.dir, process.platform === 'win32' ? 'custom-state' : 'custom-state ');
  const custom = b.start({ PORT: port, DORMOUSE_STATE_DIR: stateDir, DORMOUSE_ORIGIN: 'https://dev.example.test/' });
  const listening = await custom.listening();
  assert.equal(new URL(listening.url).port, port);
  assert.equal(listening.origin, 'https://dev.example.test');
  const response = await enroll(listening.url, await password(stateDir));
  assert.equal((await response.json()).origin, listening.origin);
});

test('production still rejects PORT=0 before creating state', async t => {
  const a = await fixture(t);
  const stateDir = path.join(a.dir, 'production-state');
  const run = a.start({ PORT: '0', DORMOUSE_STATE_DIR: stateDir }, 'dist/index.js');
  assert.equal((await run.exited).code, 1);
  assert.match(run.output, /PORT must be an integer between 1 and 65535/);
  await assert.rejects(readFile(path.join(stateDir, 'setup-password.json')), { code: 'ENOENT' });
});
