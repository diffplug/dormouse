/**
 * The runtime file is how an installer learns *which release* is answering on
 * the loopback port, so the properties that matter are: it appears only after a
 * real bind, it names this process, it is owner-only, and it is absent unless
 * an installer asked for it. Spawns the real entrypoint for the first three.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readConfig } from '../dist/config.js';
import { startServer, stopServer } from './spawn-server.mjs';

test('a bound server records its pid, release and port, owner-only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dormouse-rt-'));
  const runtimeFile = join(dir, 'run', 'server.json');
  const { child, port } = await startServer({
    DORMOUSE_RUNTIME_FILE: runtimeFile,
    DORMOUSE_RELEASE_ID: '20260101T000000Z-abc1234',
  });
  try {
    // The listening log precedes the write by a tick; give it a moment.
    let info;
    for (let i = 0; i < 40; i += 1) {
      try {
        info = JSON.parse(await readFile(runtimeFile, 'utf8'));
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    assert.ok(info, 'runtime file was never written');
    assert.equal(info.pid, child.pid);
    assert.equal(info.releaseId, '20260101T000000Z-abc1234');
    assert.equal(info.port, port);
    assert.match(info.startedAt, /^\d{4}-\d{2}-\d{2}T/);

    // It names a live process — the whole point of recording the pid is that a
    // reader can tell a stale file from a serving one.
    assert.doesNotThrow(() => process.kill(info.pid, 0));

    const mode = (await stat(runtimeFile)).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got 0${mode.toString(8)}`);
  } finally {
    await stopServer(child);
  }
});

test('nothing is written when no installer asked for it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dormouse-rt-'));
  const runtimeFile = join(dir, 'server.json');
  const { child } = await startServer({});
  try {
    await new Promise((r) => setTimeout(r, 500));
    await assert.rejects(readFile(runtimeFile, 'utf8'), /ENOENT/);
  } finally {
    await stopServer(child);
  }
});

test('a relative runtime path is refused rather than resolved against the cwd', () => {
  const env = {
    DORMOUSE_SETUP_PASSWORD: 'pw',
    DORMOUSE_ORIGIN: 'https://example.ts.net',
    DORMOUSE_RUNTIME_FILE: 'run/server.json',
  };
  assert.throws(() => readConfig(env), /must be an absolute path/);
});

test('an unset or blank runtime path yields null, not a stray relative write', () => {
  const base = { DORMOUSE_SETUP_PASSWORD: 'pw', DORMOUSE_ORIGIN: 'https://example.ts.net' };
  assert.equal(readConfig(base).runtimeFile, null);
  assert.equal(readConfig({ ...base, DORMOUSE_RUNTIME_FILE: '   ' }).runtimeFile, null);
  assert.equal(readConfig(base).releaseId, null);
});
