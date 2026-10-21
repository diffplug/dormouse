import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ptyCore from '../../standalone/sidecar/pty-core.js';
import controlServer from '../../standalone/sidecar/dor-control-server.js';

// Opt in on a Windows machine with WSL installed:
// $env:DORMOUSE_TEST_WSL_DISTRO='Ubuntu'; node --test dor/test/wsl.test.mjs
// Build dor first for the authenticated list regression. Never use the running
// app's credentials: each test injects a private fixture endpoint and identity.
const distro = process.env.DORMOUSE_TEST_WSL_DISTRO;
const skip = process.platform !== 'win32' || !distro ? 'requires DORMOUSE_TEST_WSL_DISTRO on Windows' : false;
const exec = promisify(execFile);
const launcher = fileURLToPath(new URL('../bin/dor', import.meta.url));
const cli = fileURLToPath(new URL('../dist/dor.js', import.meta.url));
const wsl = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe');

function paneEnv(cliJs, extra = {}) {
  return ptyCore.resolveSpawnConfig({
    surfaceId: 'surface:4242',
    env: {
      DORMOUSE_NODE: process.execPath,
      DORMOUSE_CLI_JS: cliJs,
      DORMOUSE_HOST: 'standalone',
      DORMOUSE_CONTROL_SOCKET: '\\\\.\\pipe\\wsl-fixture',
      DORMOUSE_CONTROL_TOKEN: 'wsl-fixture-token',
      ...extra,
    },
  }).env;
}

function runWsl(env, args, cwd = process.cwd(), linuxCwd) {
  return exec(wsl, ['-d', distro, ...(linuxCwd ? ['--cd', linuxCwd] : []), '--exec', 'sh', '-c',
    'launcher=$(wslpath -u "$1") || exit; shift; exec sh "$launcher" "$@"',
    'dor-wsl-test', launcher, ...args], { env, cwd, timeout: 20000, windowsHide: true });
}

test('WSL launcher preserves context, Windows paths, argv, cwd and failure status', { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dor WSL launcher-'));
  try {
    const stub = join(dir, 'cli with spaces.mjs');
    // A junction tests an executable path containing spaces without copying Node.
    await symlink(dirname(process.execPath), join(dir, 'runtime with spaces'), 'junction');
    const node = join(dir, 'runtime with spaces', 'node.exe');
    await writeFile(stub, `
      const keys = ['DORMOUSE_NODE', 'DORMOUSE_CLI_JS', 'DORMOUSE_HOST', 'DORMOUSE_SURFACE_ID',
        'DORMOUSE_CONTROL_SOCKET', 'DORMOUSE_CONTROL_TOKEN', 'ELECTRON_RUN_AS_NODE', 'PWD'];
      console.log(JSON.stringify({platform: process.platform, cwd: process.cwd(), env: Object.fromEntries(keys.map(k => [k, process.env[k]])), args: process.argv.slice(2)}));
      process.exitCode = Number(process.argv[2]);
    `);
    const env = paneEnv(stub, { DORMOUSE_NODE: node });
    const args = ['0', 'spaces and \"quotes\"', '$HOME; & literal'];
    const result = JSON.parse((await runWsl(env, args, dir)).stdout);
    assert.equal(result.platform, 'win32');
    assert.deepEqual(result.args, args);
    for (const key of ['DORMOUSE_NODE', 'DORMOUSE_CLI_JS', 'DORMOUSE_HOST', 'DORMOUSE_SURFACE_ID', 'DORMOUSE_CONTROL_SOCKET', 'DORMOUSE_CONTROL_TOKEN']) {
      assert.equal(result.env[key], env[key]);
    }
    assert.equal(result.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(result.env.PWD.toLowerCase(), dir.toLowerCase());
    await assert.rejects(runWsl(env, ['7'], dir), (error) => error.code === 7);
    // Linux-home callers cross back as a UNC path, not a drive-mounted path.
    const home = JSON.parse((await runWsl(env, ['0'], dir, '~')).stdout);
    assert.ok(home.env.PWD.startsWith('\\\\'));
    assert.equal(home.env.PWD.toLowerCase(), home.cwd.toLowerCase());
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('dor list from WSL authenticates to the Windows pipe with its Surface identity', { skip }, async () => {
  const requests = [];
  const surface = { id: 'surface:4242', kind: 'terminal', view: 'paned', cwd: process.cwd(), title: 'WSL fixture', focused: true };
  const server = controlServer.createDorControlServer({
    token: 'wsl-fixture-token',
    send(event, request) {
      if (event !== 'dor:controlRequest') return;
      requests.push(request);
      server.respond({ requestId: request.requestId, ok: true, result: { surfaces: [surface] } });
    },
  });
  try {
    await server.ready;
    const env = paneEnv(cli, { DORMOUSE_CONTROL_SOCKET: server.socketPath });
    const result = await runWsl(env, ['list', '--json', '--cwd', '.']);
    assert.equal(JSON.parse(result.stdout).surfaces[0]?.id, surface.id);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'surface.list');
    assert.equal(requests[0].surfaceId, 'surface:4242');
  } finally {
    server.close();
  }
});
