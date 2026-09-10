import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const scripts = path.dirname(fileURLToPath(import.meta.url));

// Real Vite/configuration, with only the expensive native CLI replaced. Its
// child stands in for Cargo/the app to verify that teardown owns the whole tree.
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'native-dev-test-')));
  const standalone = path.join(root, 'standalone');
  const bin = path.join(root, 'bin');
  await mkdir(path.join(standalone, 'scripts'), { recursive: true });
  await mkdir(path.join(standalone, 'src-tauri'));
  await mkdir(bin);
  await symlink(path.resolve(scripts, '../node_modules'), path.join(standalone, 'node_modules'), 'junction');
  for (const file of ['tauri.mjs', 'dev-standalone.mjs']) {
    await copyFile(path.join(scripts, file), path.join(standalone, 'scripts', file));
  }
  await copyFile(path.resolve(scripts, '../vite.config.ts'), path.join(standalone, 'vite.config.ts'));
  await copyFile(path.resolve(scripts, '../src-tauri/tauri.conf.json'), path.join(standalone, 'src-tauri/tauri.conf.json'));
  await writeFile(path.join(standalone, 'index.html'), '<script type="module" src="/app.js"></script>');
  await writeFile(path.join(standalone, 'app.js'), 'console.log(import.meta.env.VITE_DORMOUSE_BROWSER_DEV_HOST);');
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
  if (process.platform === 'win32') {
    await writeFile(path.join(bin, 'pnpm.cmd'), `@"${process.execPath}" "${cli}" %*\r\n`);
  } else {
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    await writeFile(path.join(bin, 'pnpm'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`, { mode: 0o755 });
  }
  const runs = [];
  t.after(async () => {
    await Promise.all(runs.map(run => run.stop()));
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    start(args = ['dev'], overrides = {}) {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DORMOUSE_|VITE_|TAURI_)/.test(key)));
      env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
      const child = spawn(process.execPath, ['--import', signals, path.join(standalone, 'scripts/tauri.mjs'), ...args], {
        cwd: standalone, env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      let output = '';
      let closed = false;
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      const exited = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => { closed = true; resolve({ code, signal }); });
      });
      const run = {
        exited,
        get output() { return output; },
        async wait(pattern) {
          const deadline = Date.now() + 20000;
          while (Date.now() < deadline) {
            const match = output.match(pattern);
            if (match) return match;
            if (closed) break;
            await delay(25);
          }
          throw new Error(`Native dev did not log ${pattern}:\n${output}`);
        },
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
          if (!closed) {
            if (process.platform === 'win32' && child.connected) child.send('SIGTERM', () => {});
            else child.kill('SIGTERM');
          }
          const timer = setTimeout(() => child.kill('SIGKILL'), 6000);
          try { return await exited; } finally { clearTimeout(timer); }
        },
      };
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
  const [one, two] = await Promise.all([
    a.start(['dev', '--no-watch', '--', '--locked', '--', 'app-arg'], {
      TAURI_DEV_HOST: '192.0.2.1', VITE_DORMOUSE_BROWSER_DEV_HOST: 'must-not-enable-browser-mode',
    }).ready(),
    b.start().ready(),
  ]);
  assert.notEqual(one.url, two.url);
  assert.notEqual(one.config.identifier, two.config.identifier);
  assert.notEqual(one.logFile, two.logFile);
  assert.match(one.config.identifier, /^sh\.dormouse\.standalone\.dev\.w[a-f0-9]{16}$/);
  assert.deepEqual(one.args.slice(-4), ['--', '--locked', '--', 'app-arg']);
  for (const run of [one, two]) {
    assert.equal(run.config.build.beforeDevCommand, null);
    assert.ok(Number(new URL(run.url).port) > 0);
    const js = await (await fetch(`${run.url}/app.js`)).text();
    const module = await import(`data:text/javascript;base64,${Buffer.from(js.replace('console.log(', 'export default (')).toString('base64')}`);
    assert.equal(module.default, undefined);
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
  const custom = await b.start(['dev'], { DORMOUSE_LOG_FILE: path.join(b.root, 'custom.log') }).ready();
  assert.equal(custom.logFile, path.join(b.root, 'custom.log'));
});

test('non-dev Tauri commands retain their arguments and production configuration', async t => {
  const a = await fixture(t);
  const run = a.start(['build', '--debug']);
  assert.equal((await run.exited).code, 0);
  assert.deepEqual(JSON.parse((await run.wait(/CLI_ARGS (.+)/))[1]), ['exec', 'tauri', 'build', '--debug']);
  assert.doesNotMatch(run.output, /app URL|NATIVE_CONFIG/);
});
