import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnAndCapture, treeKillCommand, SPAWN_TIMEOUT_CODE } from '../dist/index.js';

const node = process.execPath;

test('captures stdout and a zero exit code', async () => {
  const result = await spawnAndCapture(node, ['-e', 'process.stdout.write("hello")']);
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'hello');
});

test('captures stderr and a non-zero exit code', async () => {
  const result = await spawnAndCapture(node, ['-e', 'process.stderr.write("boom"); process.exit(3)']);
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 3);
  assert.equal(result.stderr, 'boom');
});

test('decodes UTF-8 characters split across stdout and stderr chunks', async () => {
  const result = await spawnAndCapture(node, ['-e', `
    process.stdout.write(Buffer.from([0xf0, 0x9f]));
    process.stderr.write(Buffer.from([0xe2]));
    setTimeout(() => {
      process.stdout.write(Buffer.from([0x90, 0xad]));
      process.stderr.write(Buffer.from([0x82, 0xac]));
    }, 50);
  `]);
  assert.deepEqual(result, { ok: true, exitCode: 0, stdout: '🐭', stderr: '€' });
});

test('reports a missing binary as a spawn failure, never throwing', async () => {
  const result = await spawnAndCapture('dormouse-no-such-binary-xyz', []);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ENOENT');
});

test('reports synchronous spawn validation failures without rejecting', async () => {
  for (const [binary, args] of [[node, ['bad\0argument']], ['bad\0binary', []]]) {
    const result = await spawnAndCapture(binary, args);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'ERR_INVALID_ARG_VALUE');
    assert.match(result.error.message, /null bytes/);
  }
});

test('drains normal command output before releasing capture pipes', async () => {
  const result = await spawnAndCapture(node, ['-e', `
    process.stdout.write('x'.repeat(512 * 1024));
    process.stderr.write('y'.repeat(512 * 1024));
    process.exitCode = 9;
  `]);
  assert.deepEqual(result, {
    ok: true, exitCode: 9,
    stdout: 'x'.repeat(512 * 1024), stderr: 'y'.repeat(512 * 1024),
  });
});

test('releases inherited pipes so the capture caller can exit while the daemon lives', async () => {
  // This test launches a capture caller, whose short-lived command starts a
  // daemon sharing its pipes. A resolved promise alone does not prove that the
  // caller's event loop can exit.
  const daemonScript = `
    process.stdout.on('error', () => {});
    process.stderr.on('error', () => {});
    setInterval(() => {
      try { process.kill(Number(process.argv[1]), 0); }
      catch { process.stderr.write('daemon noise'); }
    }, 100);
    setTimeout(() => process.exit(), 30000);
  `;
  const commandScript = `
    const { spawn } = require('node:child_process');
    const daemon = spawn(process.execPath, ['-e', ${JSON.stringify(daemonScript)}, String(process.pid)], {
      stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
    });
    daemon.unref();
    process.stdout.write(String(daemon.pid));
    process.stderr.write('command stderr');
    process.exitCode = 7;
  `;
  const callerScript = `
    import { spawnAndCapture } from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
    const result = await spawnAndCapture(process.execPath, ['-e', ${JSON.stringify(commandScript)}]);
    process.stdout.write(JSON.stringify(result));
  `;
  let stdout = '';
  try {
    try {
      ({ stdout } = await promisify(execFile)(node, ['--input-type=module', '-e', callerScript], {
        timeout: 5000, windowsHide: true,
      }));
    } catch (error) {
      stdout = error.stdout ?? '';
      throw error;
    }
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 7);
    assert.equal(result.stderr, 'command stderr');
    assert.doesNotThrow(() => process.kill(Number(result.stdout), 0), 'capture must not kill the daemon');
  } finally {
    // Clean up even when the old implementation times out after reporting its
    // successful capture. The daemon also has a bounded lifetime as a backstop.
    if (stdout) {
      const pid = Number(JSON.parse(stdout).stdout);
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid); } catch { /* already exited */ }
      }
    }
  }
});

test('runs relative paths in the requested cwd without changing the caller cwd', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'dor-spawn-cwd-'));
  const before = process.cwd();
  try {
    const result = await spawnAndCapture(node, ['-e', 'process.stdout.write(process.cwd())'], { cwd });
    assert.equal(result.ok, true);
    assert.equal(result.stdout, await realpath(cwd));
    assert.equal(process.cwd(), before);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('a timeout kills a hung child and resolves with a distinct error', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dormouse-spawn-timeout-'));
  try {
    const pidFile = path.join(dir, 'pid');
    const started = Date.now();
    const result = await spawnAndCapture(node, ['-e', `
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      setTimeout(() => {}, 60000);
    `], { timeoutMs: 500 });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, SPAWN_TIMEOUT_CODE);
    assert.ok(Date.now() - started < 5000);
    const { readFile } = await import('node:fs/promises');
    const pid = Number(await readFile(pidFile, 'utf8'));
    // The kill is not awaited; give the signal a moment to land.
    for (let i = 0; i < 50; i++) {
      try { process.kill(pid, 0); } catch { return; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(`child ${pid} survived its timeout`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a command that finishes inside its timeout resolves normally', async () => {
  const result = await spawnAndCapture(node, ['-e', 'process.stdout.write("done")'], { timeoutMs: 10000 });
  assert.deepEqual(result, { ok: true, exitCode: 0, stdout: 'done', stderr: '' });
});

test('Windows ends a timed-out child\'s whole tree with taskkill by absolute path', () => {
  assert.equal(treeKillCommand(42, {}, false), null);
  assert.deepEqual(treeKillCommand(42, { SystemRoot: 'D:\\Win' }, true), {
    binary: 'D:\\Win\\System32\\taskkill.exe', args: ['/PID', '42', '/T', '/F'],
  });
  assert.equal(treeKillCommand(42, {}, true).binary, 'C:\\Windows\\System32\\taskkill.exe');
});
