import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { spawnAndCapture } from '../dist/index.js';

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

test('reports a missing binary as a spawn failure, never throwing', async () => {
  const result = await spawnAndCapture('dormouse-no-such-binary-xyz', []);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ENOENT');
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
