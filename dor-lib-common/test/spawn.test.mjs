import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cmdShimTarget, envValue, spawnAndCapture, treeKillCommand, SPAWN_TIMEOUT_CODE } from '../dist/index.js';

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
  // caller's event loop can exit. Detach the daemon from the short-lived
  // Windows console too; inheriting capture pipes alone does not make it
  // independent of the command's console lifetime.
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
      stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true, detached: true,
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
    assert.equal(await realpath(result.stdout), await realpath(cwd));
    assert.equal(process.cwd(), before);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

const windowsOnly = process.platform === 'win32' ? false : 'Windows shims';

test('reads the target of agent-browser, npm cmd-shim and pnpm shims', { skip: windowsOnly }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dor-shim-'));
  try {
    const exe = path.join(dir, 'node_modules', 'agent-browser', 'bin', 'agent-browser-win32-x64.exe');
    const script = path.join(dir, 'node_modules', '@playwright', 'cli', 'cli.js');
    await mkdir(path.dirname(exe), { recursive: true });
    await mkdir(path.dirname(script), { recursive: true });
    await writeFile(exe, '');
    await writeFile(script, '');
    const env = { PATH: path.dirname(node), PATHEXT: '.exe' };
    const shim = async (name, text) => { const file = path.join(dir, name); await writeFile(file, text); return file; };

    assert.deepEqual(cmdShimTarget(await shim('agent-browser.cmd', '@ECHO off\r\n"%~dp0node_modules\\agent-browser\\bin\\agent-browser-win32-x64.exe" %*\r\n'), env),
      { binary: exe, args: [] });
    assert.deepEqual(cmdShimTarget(await shim('playwright-cli.cmd', 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@playwright\\cli\\cli.js" %*\r\n'), env),
      { binary: node, args: [script] });
    // pnpm names the target twice, once per node branch, and climbs out of .bin.
    const bin = path.join(dir, 'node_modules', '.bin');
    await mkdir(bin);
    assert.deepEqual(cmdShimTarget(await shim('node_modules/.bin/playwright-cli.cmd', '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\..\\@playwright\\cli\\cli.js" %*\r\n) ELSE (\r\n  node  "%~dp0\\..\\@playwright\\cli\\cli.js" %*\r\n)\r\n'), env),
      { binary: node, args: [script] });
    // A node.exe beside the shim wins over PATH, as the shim itself decides.
    await writeFile(path.join(dir, 'node.exe'), '');
    assert.deepEqual(cmdShimTarget(path.join(dir, 'playwright-cli.cmd'), env), { binary: path.join(dir, 'node.exe'), args: [script] });

    // A copy of Windows' process.env keeps its stored `Path` spelling.
    const playwright = path.join(dir, 'playwright-cli.cmd');
    await rm(path.join(dir, 'node.exe'));
    assert.deepEqual(cmdShimTarget(playwright, { Path: path.dirname(node), PATHEXT: '.exe' }), { binary: node, args: [script] });

    assert.equal(cmdShimTarget(await shim('two.cmd', '"%~dp0a.exe" %*\r\n"%~dp0b.exe" %*\r\n'), env), undefined);
    assert.equal(cmdShimTarget(await shim('missing.cmd', '"%~dp0nothing.exe" %*\r\n'), env), undefined);
    assert.equal(cmdShimTarget(await shim('npx.cmd', '"%NODE_EXE%" "%NPX_CLI_JS%" %*\r\n'), env), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('reads PATH by any spelling on Windows, and only by its own elsewhere', () => {
  assert.equal(envValue({ Path: 'C:\\bin' }, 'PATH', true), 'C:\\bin');
  assert.equal(envValue({ PATH: 'upper', Path: 'stored' }, 'PATH', true), 'upper');
  assert.equal(envValue({ PathExt: '.EXE' }, 'PATH', true), undefined);
  assert.equal(envValue({ Path: '/bin' }, 'PATH', false), undefined);
});

test('a .cmd shim started in a UNC cwd runs its target there, not in %SystemRoot%', { skip: windowsOnly }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dor-unc-'));
  // The admin share is the UNC path every Windows machine has, as WSL's would be.
  const unc = `\\\\localhost\\${dir[0]}$${dir.slice(2)}`;
  try {
    if (!existsSync(unc)) return;
    await mkdir(path.join(dir, 'node_modules', 'cwd-cli'), { recursive: true });
    await writeFile(path.join(dir, 'node_modules', 'cwd-cli', 'cli.js'), 'process.stdout.write(process.cwd() + "|" + process.argv.slice(2).join("|"))');
    const shim = path.join(dir, 'cwd-cli.cmd');
    await writeFile(shim, '@SETLOCAL\r\nnode  "%~dp0\\node_modules\\cwd-cli\\cli.js" %*\r\n');
    const result = await spawnAndCapture(shim, ['50%', 'a "b"'], { cwd: unc, env: { ...process.env, PATH: path.dirname(node) } });
    assert.equal(result.ok, true);
    assert.equal(result.stdout.toLowerCase(), `${unc}|50%|a "b"`.toLowerCase());
  } finally { await rm(dir, { recursive: true, force: true }); }
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

test('bounds combined output without returning captured secrets', async () => {
  const result = await spawnAndCapture(node, ['-e', 'process.stdout.write("secret".repeat(1000)); setInterval(() => {}, 1000)'], { maxOutputBytes: 100, timeoutMs: 2000 });
  assert.deepEqual(result, { ok: false, error: { code: 'ENOBUFS', message: 'Child output exceeded the capture limit' } });
});

test('writes input to stdin, and a child that never reads it still resolves', async () => {
  const echo = await spawnAndCapture(node, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'a\0b/\0' });
  assert.deepEqual(echo, { ok: true, exitCode: 0, stdout: 'a\0b/\0', stderr: '' });
  // Larger than any pipe buffer, so the write fails with EPIPE once the child exits.
  const unread = await spawnAndCapture(node, ['-e', 'process.exit(1)'], { input: 'x'.repeat(8 * 1024 * 1024) });
  assert.deepEqual(unread, { ok: true, exitCode: 1, stdout: '', stderr: '' });
});
