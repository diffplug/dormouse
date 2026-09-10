import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanEnv, devWorkspace, runner, writeShims } from './dev-fixture.mjs';

const scripts = path.dirname(fileURLToPath(import.meta.url));

// Real Vite/configuration, with only the expensive native CLI replaced. Its
// child stands in for Cargo/the app to verify that teardown owns the whole tree.
async function fixture(t) {
  const { root, standalone, bin } = await devWorkspace('native-dev-test');
  await mkdir(path.join(standalone, 'src-tauri'));
  await Promise.all([
    ...['tauri.mjs', 'dev-standalone.mjs', 'dev-run.mjs', 'clean-dev-sidecar.mjs'].map(file =>
      copyFile(path.join(scripts, file), path.join(standalone, 'scripts', file))),
    copyFile(path.resolve(scripts, '../src-tauri/tauri.conf.json'), path.join(standalone, 'src-tauri/tauri.conf.json')),
  ]);
  // Windows kill('SIGTERM') bypasses JS handlers. Deliver the same shutdown
  // event over IPC there; POSIX tests continue exercising the actual signal.
  const signals = path.join(bin, 'signals.mjs');
  await writeFile(signals, "process.on('message', signal => process.emit(signal));");
  const cli = path.join(bin, 'cli.cjs');
  await writeFile(cli, `
    const args = process.argv.slice(2);
    console.log('CLI_ARGS ' + JSON.stringify(args));
    if (args[2] !== 'dev') process.exit(0);
    const config = JSON.parse(args[args.lastIndexOf('--config') + 1]);
    console.log('NATIVE_CONFIG ' + JSON.stringify(config));
    console.log('NATIVE_LOG ' + process.env.DORMOUSE_LOG_FILE);
    fetch(config.build.devUrl).then(response => {
      if (!response.ok) process.exit(3);
      if (process.env.TEST_NATIVE_EXIT) process.exit(Number(process.env.TEST_NATIVE_EXIT));
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      console.log('APP_PID ' + child.pid);
      setInterval(() => {}, 1000);
      console.log('NATIVE_READY');
    });
  `);
  await writeShims(bin, cli, ['pnpm']);
  const runs = [];
  t.after(async () => {
    await Promise.all(runs.map(run => run.stop()));
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    start(args = ['dev'], overrides = {}) {
      const child = spawn(process.execPath, ['--import', signals, path.join(standalone, 'scripts/tauri.mjs'), ...args], {
        cwd: standalone, env: { ...cleanEnv(bin), ...overrides }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      // Object.assign, not a spread: `runner`'s `output`/`closed` are getters
      // over live state, and spreading would snapshot them once.
      const run = Object.assign(runner(child, 'Native dev'), {
        async ready() {
          await this.wait(/NATIVE_READY/);
          this.config = JSON.parse((await this.wait(/NATIVE_CONFIG (.+)/))[1]);
          this.url = this.config.build.devUrl;
          this.logFile = (await this.wait(/NATIVE_LOG (.+)/))[1];
          this.appPid = Number((await this.wait(/APP_PID (\d+)/))[1]);
          this.args = JSON.parse((await this.wait(/CLI_ARGS (.+)/))[1]);
          return this;
        },
        async stop() {
          if (!this.closed) {
            if (process.platform === 'win32' && child.connected) child.send('SIGTERM', () => {});
            else child.kill('SIGTERM');
          }
          const timer = setTimeout(() => child.kill('SIGKILL'), 6000);
          try { return await this.exited; } finally { clearTimeout(timer); }
        },
      });
      runs.push(run);
      return run;
    },
  };
}

async function assertStopped(run) {
  await assert.rejects(fetch(run.url, { signal: AbortSignal.timeout(1000) }));
  await assert.rejects(async () => {
    for (let attempt = 0; attempt < 40; attempt++) {
      process.kill(run.appPid, 0);
      await delay(25);
    }
  }, { code: 'ESRCH' });
}

test('parallel native dev runs isolate listeners, app data and logs, and stop only their own children', { timeout: 60000 }, async t => {
  const [a, b] = await Promise.all([fixture(t), fixture(t)]);
  const [one, two, custom] = await Promise.all([
    a.start(['dev', '--no-watch', '--', '--locked', '--', 'app-arg'], {
      TAURI_DEV_HOST: '192.0.2.1', VITE_DORMOUSE_BROWSER_DEV_HOST: 'must-not-enable-browser-mode',
    }).ready(),
    b.start().ready(),
    b.start(['dev'], { DORMOUSE_LOG_FILE: path.join(b.root, 'custom.log') }).ready(),
  ]);
  assert.equal(custom.logFile, path.join(b.root, 'custom.log'));
  await custom.stop();
  assert.notEqual(one.url, two.url);
  assert.notEqual(one.config.identifier, two.config.identifier);
  assert.notEqual(one.logFile, two.logFile);
  assert.match(one.config.identifier, /^sh\.dormouse\.standalone\.dev\.w[a-f0-9]{16}$/);
  assert.deepEqual(one.args.slice(-4), ['--', '--locked', '--', 'app-arg']);
  for (const run of [one, two]) {
    assert.equal(run.config.build.beforeDevCommand, null);
    // Native mode, even though run `one` inherited the browser-dev host var.
    const js = await (await fetch(`${run.url}/app.js`)).text();
    assert.match(js, /"VITE_DORMOUSE_BROWSER_DEV_HOST": undefined/);
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(run.url.replace('http:', 'ws:'), 'vite-ping');
      const timer = setTimeout(() => { ws.close(); reject(new Error('HMR did not connect')); }, 5000);
      ws.addEventListener('open', () => { clearTimeout(timer); ws.close(); resolve(); });
      ws.addEventListener('error', event => { clearTimeout(timer); reject(event); });
    });
  }
  assert.equal((await one.stop()).code, 0);
  await assertStopped(one);
  assert.equal((await fetch(two.url)).status, 200);
  process.kill(two.appPid, 0);
  const restarted = await a.start().ready();
  assert.equal(restarted.config.identifier, one.config.identifier);
  assert.equal(restarted.logFile, one.logFile);
});

test('an occupied explicit port fails without touching its owner; native failures close Vite', { timeout: 60000 }, async t => {
  const [a, b] = await Promise.all([fixture(t), fixture(t)]);
  const one = await a.start().ready();
  const port = new URL(one.url).port;
  const collision = b.start(['dev'], { DORMOUSE_BROWSER_DEV_VITE_PORT: port });
  assert.equal((await collision.exited).code, 1);
  assert.match(collision.output, /already in use/);
  assert.doesNotMatch(collision.output, /CLI_ARGS/);
  assert.equal((await fetch(one.url)).status, 200);
  await one.stop();
  const failed = b.start(['dev'], { DORMOUSE_BROWSER_DEV_VITE_PORT: port, TEST_NATIVE_EXIT: '7' });
  assert.equal((await failed.exited).code, 7);
  await assert.rejects(fetch(one.url));
});

test('non-dev Tauri commands retain their arguments and production configuration', async t => {
  const a = await fixture(t);
  const run = a.start(['build', '--debug']);
  assert.equal((await run.exited).code, 0);
  assert.deepEqual(JSON.parse((await run.wait(/CLI_ARGS (.+)/))[1]), ['exec', 'tauri', 'build', '--debug']);
  assert.doesNotMatch(run.output, /app URL|NATIVE_CONFIG/);
});
