import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { sessionForKey } from 'dor-lib-common/agent-browser';

const scripts = path.dirname(fileURLToPath(import.meta.url));

// Exercise the shipped harness with real Vite and HTTP listeners. Only the PTY
// runtime and browser CLI are substitutes; tests never launch a user's browser.
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'innerdogfood-test-')));
  const standalone = path.join(root, 'standalone');
  const bin = path.join(root, 'bin');
  await mkdir(path.join(standalone, 'scripts'), { recursive: true });
  await mkdir(path.join(standalone, 'sidecar'));
  await mkdir(bin);
  await symlink(path.resolve(scripts, '../node_modules'), path.join(standalone, 'node_modules'), 'junction');
  for (const name of ['dev-agent-browser.mjs', 'dev-host-guard.mjs']) {
    await copyFile(path.join(scripts, name), path.join(standalone, 'scripts', name));
  }
  await copyFile(path.resolve(scripts, '../vite.config.ts'), path.join(standalone, 'vite.config.ts'));
  await writeFile(path.join(standalone, 'index.html'), '<script type="module" src="/app.js"></script>');
  await writeFile(path.join(standalone, 'app.js'), 'console.log(import.meta.env.VITE_DORMOUSE_BROWSER_DEV_HOST);');
  await writeFile(path.join(standalone, 'sidecar/main.js'), `
    const { createInterface } = require('node:readline');
    createInterface({ input: process.stdin }).on('line', line => {
      const { event, data } = JSON.parse(line);
      if (event === 'pty:getCwd') console.log(JSON.stringify({
        event: 'pty:cwd', data: { requestId: data.requestId, cwd: process.env.VITE_DORMOUSE_BROWSER_DEV_HOST || process.cwd() }
      }));
    });
  `);
  const cli = path.join(bin, 'cli.cjs');
  await writeFile(cli, `
    console.log('BROWSER_ARGS ' + JSON.stringify(process.argv.slice(2)));
    if (process.env.TEST_BROWSER_HANG) {
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
      console.log('BROWSER_PID ' + process.pid);
    } else {
      process.exit(Number(process.env.TEST_BROWSER_EXIT || 0));
    }
  `);
  for (const name of ['agent-browser', 'dor']) {
    if (process.platform === 'win32') {
      await writeFile(path.join(bin, `${name}.cmd`), `@"${process.execPath}" "${cli}" %*\r\n`);
    } else {
      const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
      await writeFile(path.join(bin, name), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`, { mode: 0o755 });
    }
  }
  const runs = [];
  t.after(async () => {
    await Promise.all(runs.map(run => run.stop()));
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    start(overrides = {}) {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DORMOUSE_|VITE_|TAURI_)/.test(key)));
      env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
      const child = spawn(process.execPath, [path.join(standalone, 'scripts/dev-agent-browser.mjs')], {
        cwd: root, env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      let closed = false;
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      const exited = new Promise((resolve, reject) => {
        child.once('error', reject);
        // close includes stdio EOF, so final diagnostics are available to assertions.
        child.once('close', (code, signal) => {
          closed = true;
          resolve({ code, signal });
        });
      });
      const run = {
        child, exited,
        get output() { return output; },
        async wait(pattern) {
          const deadline = Date.now() + 20000;
          while (Date.now() < deadline) {
            const match = output.match(pattern);
            if (match) return match;
            if (closed) break;
            await delay(25);
          }
          throw new Error(`Harness did not log ${pattern}:\n${output}`);
        },
        async ready() {
          await this.wait(/running; Ctrl-C to stop/);
          this.app = (await this.wait(/app URL: (http:\/\/localhost:\d+)/))[1];
          this.bridge = (await this.wait(/starting browser dev host on (http:\/\/127.0.0.1:\d+)/))[1];
          this.token = (await this.wait(/bridge token: ([a-f0-9]+)/))[1];
          this.session = (await this.wait(/agent-browser session: (\S+)/))[1];
          this.args = JSON.parse((await this.wait(/BROWSER_ARGS (.+)/))[1]);
          return this;
        },
        async stop() {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
          const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
          try { return await exited; } finally { clearTimeout(timer); }
        },
      };
      runs.push(run);
      return run;
    },
  };
}

async function invoke(run, token = run.token, origin = run.app) {
  return fetch(`${run.bridge}/__dormouse_dev_host/invoke?t=${token}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ cmd: 'pty_get_cwd', args: { id: 'test' } }),
    signal: AbortSignal.timeout(5000),
  });
}

async function assertClosed(run) {
  for (const url of [run.app, run.bridge]) {
    await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }));
  }
}

test('parallel worktrees own ports, browser identities and bridges; stopping one preserves the other', { timeout: 60000 }, async t => {
  const [a, b] = await Promise.all([fixture(t), fixture(t)]);
  const [one, two] = await Promise.all([
    a.start({ DORMOUSE_SURFACE_ID: 'outer-pane', TAURI_DEV_HOST: '192.0.2.1' }).ready(), b.start().ready(),
  ]);
  assert.equal(new Set([one.app.split(':').at(-1), two.app.split(':').at(-1), one.bridge.split(':').at(-1), two.bridge.split(':').at(-1)]).size, 4);
  assert.notEqual(one.session, two.session);
  assert.notEqual(one.token, two.token);
  const key = one.args[2];
  assert.match(key, /^innerdogfood-[a-f0-9]{16}$/);
  assert.deepEqual(one.args, ['ab', '--key', key, 'open', one.app]);
  assert.equal(one.session, sessionForKey(key));
  assert.deepEqual(two.args, ['--session', two.session, 'open', two.app]);
  for (const [run, dir, other] of [[one, a.root, two], [two, b.root, one]]) {
    const js = await (await fetch(`${run.app}/app.js`)).text();
    assert.ok(js.includes(`${run.bridge}/?t=${run.token}`));
    // HMR must share this listener, even with a Tauri-specific host inherited.
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(run.app.replace('http:', 'ws:'), 'vite-ping');
      const timer = setTimeout(() => { ws.close(); reject(new Error('HMR did not connect')); }, 5000);
      ws.addEventListener('open', () => { clearTimeout(timer); ws.close(); resolve(); });
      ws.addEventListener('error', event => { clearTimeout(timer); reject(event); });
    });
    const response = await invoke(run);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), run.app);
    assert.deepEqual(await response.json(), { ok: true, result: path.join(dir, 'standalone/sidecar') });
    assert.equal((await invoke(run, other.token)).status, 404);
    assert.equal((await invoke(run, run.token, other.app)).headers.get('access-control-allow-origin'), run.app);
  }
  assert.equal((await one.stop()).code, 0);
  await assertClosed(one);
  assert.equal((await invoke(two)).status, 200);
  const restarted = await a.start().ready();
  assert.equal(restarted.session, one.session);
});

test('explicit ports and raw browser sessions are honored; occupied ports fail without adopting a peer', { timeout: 60000 }, async t => {
  const a = await fixture(t);
  const one = await a.start().ready();
  const hostPort = one.bridge.split(':').at(-1);
  const vitePort = one.app.split(':').at(-1);
  const b = await fixture(t);
  const hostCollision = b.start({ DORMOUSE_BROWSER_DEV_HOST_PORT: hostPort });
  assert.equal((await hostCollision.exited).code, 1);
  assert.match(hostCollision.output, /EADDRINUSE/);
  const viteCollision = b.start({ DORMOUSE_BROWSER_DEV_VITE_PORT: vitePort });
  assert.equal((await viteCollision.exited).code, 1);
  assert.match(viteCollision.output, /already in use/);
  assert.doesNotMatch(viteCollision.output, /BROWSER_ARGS/);
  const failedBridge = (await viteCollision.wait(/starting browser dev host on (http:\/\/127.0.0.1:\d+)/))[1];
  await assert.rejects(fetch(failedBridge));
  assert.equal((await invoke(one)).status, 200);
  await one.stop();
  const pinned = await b.start({
    DORMOUSE_SURFACE_ID: 'outer-pane', DORMOUSE_BROWSER_DEV_AB_SESSION: 'explicit-session',
    DORMOUSE_BROWSER_DEV_HOST_PORT: hostPort, DORMOUSE_BROWSER_DEV_VITE_PORT: vitePort,
  }).ready();
  assert.equal(pinned.app, one.app);
  assert.equal(pinned.bridge, one.bridge);
  assert.deepEqual(pinned.args, ['ab', '--session', 'explicit-session', 'open', pinned.app]);
});

test('browser startup failure closes the harness listeners and sidecar', { timeout: 30000 }, async t => {
  const a = await fixture(t);
  const run = a.start({ TEST_BROWSER_EXIT: '7' });
  assert.equal((await run.exited).code, 1);
  assert.match(run.output, /agent-browser exited code=7/);
  assert.doesNotMatch(run.output, /running; Ctrl-C/);
  run.app = (await run.wait(/app URL: (http:\/\/localhost:\d+)/))[1];
  run.bridge = (await run.wait(/starting browser dev host on (http:\/\/127.0.0.1:\d+)/))[1];
  await assertClosed(run);
  const pid = Number((await run.wait(/sidecar pid=(\d+)/))[1]);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('shutdown kills an owned browser launcher that ignores SIGTERM', {
  timeout: 30000, skip: process.platform === 'win32',
}, async t => {
  const a = await fixture(t);
  const run = a.start({ TEST_BROWSER_HANG: '1' });
  const pid = Number((await run.wait(/BROWSER_PID (\d+)/))[1]);
  t.after(() => {
    try { process.kill(pid, 'SIGKILL'); } catch (err) {
      if (err.code !== 'ESRCH') throw err;
    }
  });
  assert.equal((await run.stop()).code, 0);
  // SIGKILL delivery and orphan reaping can finish just after the harness exits.
  await assert.rejects(async () => {
    for (let attempt = 0; attempt < 40; attempt++) {
      process.kill(pid, 0);
      await delay(25);
    }
  }, { code: 'ESRCH' });
});
