import test from 'node:test';
import assert from 'node:assert/strict';
import { access, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { get } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { sessionForKey } from 'dor-lib-common/browser-providers';
import { cleanEnv, devWorkspace, runner, writeShims } from './dev-fixture.mjs';

const scripts = path.dirname(fileURLToPath(import.meta.url));

// Exercise the shipped harness with real Vite and HTTP listeners. Only the PTY
// runtime and browser CLI are substitutes; tests never launch a user's browser.
async function fixture(t) {
  const { root, standalone, bin } = await devWorkspace('innerdogfood-test');
  await mkdir(path.join(standalone, 'sidecar'));
  await Promise.all(['dev-agent-browser.mjs', 'dev-host-guard.mjs', 'dev-run.mjs'].map(name =>
    copyFile(path.join(scripts, name), path.join(standalone, 'scripts', name))));
  await writeFile(path.join(standalone, 'sidecar/main.js'), `
    console.error('SIDECAR_AB_DIR ' + process.env.AGENT_BROWSER_SOCKET_DIR);
    const { createInterface } = require('node:readline');
    createInterface({ input: process.stdin }).on('line', line => {
      const { event, data } = JSON.parse(line);
      if (event === 'alert:command' || event === 'pty:input') console.error('SIDECAR_LINE ' + line);
      if (event === 'pty:getCwd') console.log(JSON.stringify({
        event: 'pty:cwd', data: { requestId: data.requestId, cwd: process.env.VITE_DORMOUSE_BROWSER_DEV_HOST || process.cwd() }
      }));
    });
  `);
  const cli = path.join(bin, 'cli.cjs');
  // Windows kill('SIGTERM') bypasses JS handlers. Exercise the same shutdown
  // handler over IPC there; POSIX continues exercising the actual signal.
  const signals = path.join(bin, 'signals.mjs');
  await writeFile(signals, "process.on('message', signal => process.emit(signal));");
  await writeFile(cli, `
    if (process.argv[2] === 'list' && process.env.TEST_DOR_LIST) {
      console.log(process.env.TEST_DOR_LIST);
      process.exit(0);
    }
    console.log('BROWSER_ARGS ' + JSON.stringify(process.argv.slice(2)));
    console.log('BROWSER_AB_DIR ' + (process.env.AGENT_BROWSER_SOCKET_DIR || ''));
    if (process.env.TEST_BROWSER_HANG) {
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
      console.log('BROWSER_PID ' + process.pid);
    } else {
      process.exit(Number(process.env.TEST_BROWSER_EXIT || 0));
    }
  `);
  await writeShims(bin, cli, ['agent-browser', 'dor']);
  const runs = [];
  t.after(async () => {
    await Promise.all(runs.map(run => run.stop()));
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    start(overrides = {}) {
      const child = spawn(process.execPath, ['--import', pathToFileURL(signals).href, path.join(standalone, 'scripts/dev-agent-browser.mjs')], {
        cwd: root, env: { ...cleanEnv(bin), ...overrides }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      // Object.assign, not a spread: `runner`'s `output`/`closed` are getters
      // over live state, and spreading would snapshot them once.
      const run = Object.assign(runner(child, 'Harness'), {
        child,
        async ready() {
          await this.wait(/running; Ctrl-C to stop/);
          this.app = (await this.wait(/app URL: (http:\/\/localhost:\d+)/))[1];
          this.bridge = (await this.wait(/starting browser dev host on (http:\/\/127.0.0.1:\d+)/))[1];
          this.token = (await this.wait(/bridge token: ([a-f0-9]+)/))[1];
          const identity = await this.wait(/agent-browser (session|key): (\S+)/);
          this.identityKind = identity[1];
          this.session = identity[2];
          this.args = JSON.parse((await this.wait(/BROWSER_ARGS (.+)/))[1]);
          return this;
        },
        async stop() {
          if (child.exitCode === null && child.signalCode === null) {
            if (process.platform === 'win32' && child.connected) child.send('SIGTERM', () => {});
            else child.kill('SIGTERM');
          }
          const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
          try { return await this.exited; } finally { clearTimeout(timer); }
        },
      });
      runs.push(run);
      return run;
    },
  };
}

async function invoke(run, token = run.token, origin = run.app, cmd = 'pty_get_cwd', args = { id: 'test' }) {
  return fetch(`${run.bridge}/__dormouse_dev_host/invoke?t=${token}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ cmd, args }),
    signal: AbortSignal.timeout(5000),
  });
}

async function send(run, cmd, args) {
  return fetch(`${run.bridge}/__dormouse_dev_host/send?t=${run.token}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: run.app },
    body: JSON.stringify({ cmd, args }),
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
  assert.deepEqual(one.args, ['agent-browser', '--key', key, 'open', one.app]);
  // Inside Dormouse the harness names the key, not a session: the Workspace that
  // takes the browser is what namespaces it, so `sessionForKey`'s bare-Wall scope
  // would be a session nothing ever created.
  assert.equal(one.identityKind, 'key');
  assert.equal(one.session, key);
  assert.notEqual(one.session, sessionForKey(key));
  assert.equal(two.identityKind, 'session');
  assert.deepEqual(two.args, ['--session', two.session, 'open', two.app]);
  for (const [run, dir, other] of [[one, a.root, two], [two, b.root, one]]) {
    const js = await (await fetch(`${run.app}/app.js`)).text();
    assert.ok(js.includes(`${run.bridge}/?t=${run.token}`));
    // `cors: false` in dev-run.mjs, pinned here because nothing else would
    // notice its removal: these modules carry the bridge token, and Vite's
    // default answers every http://localhost:* origin with an acao of its own,
    // which is a read of the token by any other page in the developer's browser.
    const foreign = await fetch(`${run.app}/app.js`, { headers: { origin: 'http://localhost:31337' } });
    assert.equal(foreign.status, 200);
    assert.equal(foreign.headers.get('access-control-allow-origin'), null);
    // DNS rebinding looks same-origin to a browser; the Host check must refuse it.
    const reboundStatus = await new Promise((resolve, reject) => {
      get(`${run.app}/app.js`, {
        headers: { host: 'evil.example' }, signal: AbortSignal.timeout(5000),
      }, response => {
        response.resume();
        resolve(response.statusCode);
      }).on('error', reject);
    });
    assert.equal(reboundStatus, 403);
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
  // Stable across restarts: the identity is derived from the canonical worktree
  // path. This run is outside Dormouse, so it resolves the same key and prints
  // it namespaced.
  const restarted = await a.start().ready();
  assert.equal(restarted.session, sessionForKey(one.session));
});

// The harness speaks the same sidecar protocol Rust does: one fixed window
// label stamped on every alert command, over anything the page claimed, and a
// write's `userInput` and `launch` riding the write (docs/specs/standalone.md -> "Alerts").
test('stamps its one window on alert commands and carries userInput and launch on the write', { timeout: 60000 }, async t => {
  const run = await (await fixture(t)).start().ready();
  const line = async (pattern) => JSON.parse((await run.wait(pattern))[1]);
  assert.equal((await send(run, 'alert_command', { payload: { op: 'hello', window: 'ws-9' } })).status, 200);
  assert.deepEqual(await line(/SIDECAR_LINE (\{"event":"alert:command".*\})/), {
    event: 'alert:command', data: { op: 'hello', window: 'main' },
  });
  assert.equal((await send(run, 'pty_write', { id: 'p1', data: 'y', userInput: true })).status, 200);
  assert.deepEqual(await line(/SIDECAR_LINE (\{"event":"pty:input".*\})/), {
    event: 'pty:input', data: { id: 'p1', data: 'y', userInput: true },
  });
  assert.equal((await send(run, 'pty_write', { id: 'p1', data: 'view\r', launch: true })).status, 200);
  assert.deepEqual(await line(/SIDECAR_LINE (\{"event":"pty:input".*"launch".*\})/), {
    event: 'pty:input', data: { id: 'p1', data: 'view\r', launch: true },
  });
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
  assert.deepEqual(pinned.args, ['agent-browser', '--session', 'explicit-session', 'open', pinned.app]);
});

test('the inner app gets its own agent-browser socket dir; the harness browser keeps the caller\'s', { timeout: 60000 }, async t => {
  const harness = await fixture(t);
  const run = await harness.start({ AGENT_BROWSER_SOCKET_DIR: '/outer/agent-browser' }).ready();
  const inner = (await run.wait(/SIDECAR_AB_DIR (\S+)/))[1];
  assert.notEqual(inner, '/outer/agent-browser');
  await access(inner);
  assert.equal((await run.wait(/BROWSER_AB_DIR (\S+)/))[1], '/outer/agent-browser');
});

test('run as a Tool, leaves the browser to the Tool instead of opening a second', { timeout: 60000 }, async t => {
  const harness = await fixture(t);
  const run = harness.start({
    DORMOUSE_SURFACE_ID: 'outer-pane',
    TEST_DOR_LIST: JSON.stringify({ caller_surface_id: 'surface:4', surfaces: [] }),
  });
  await run.wait(/running; Ctrl-C to stop/);
  assert.match(run.output, /Tool surface:4 shows the app; try: dor agent-browser --surface surface:4 snapshot -i/);
  assert.doesNotMatch(run.output, /BROWSER_ARGS/);
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


/** One bridge invoke that must succeed, answering its result. */
async function command(run, cmd, args = {}) {
  const response = await invoke(run, run.token, run.app, cmd, args);
  assert.equal(response.status, 200);
  return (await response.json()).result;
}

test('registry seeds reservations above restored IDs, reading id numbers as Rust does', async t => {
  const f = await fixture(t);
  const run = await f.start().ready();
  const cases = JSON.parse(await readFile(path.join(scripts, 'workspace-id-cases.json'), 'utf8'));
  await command(run, 'workspace_report', { entries: cases.map(({ id }) => ({ id, name: id, active: false })) });
  const registry = await command(run, 'workspace_registry');
  assert.deepEqual(registry.windows[0].workspaces.map(({ id }) => id), cases.map(({ id }) => id));
  const highest = Math.max(...cases.map(({ number }) => number ?? 0));
  assert.deepEqual(await command(run, 'workspace_reserve_ids', { count: 1 }), [`workspace:${highest + 1}`]);
  await command(run, 'workspace_report', { entries: [{ id: 'workspace:400', name: 'Restored', active: true }] });
  assert.deepEqual(await command(run, 'workspace_reserve_ids', { count: 2 }), ['workspace:401', 'workspace:402']);
  // Repeated/lower restored reports never wind the process counter backwards.
  await command(run, 'workspace_report', { entries: [{ id: 'workspace:400', name: 'Restored', active: true }] });
  assert.deepEqual(await command(run, 'workspace_reserve_ids', { count: 1 }), ['workspace:403']);
  // Surface ids stay above the floor the page restored, and never wind back.
  assert.deepEqual(await command(run, 'surface_reserve_ids', { count: 2, floor: 0 }), ['surface:1', 'surface:2']);
  assert.deepEqual(await command(run, 'surface_reserve_ids', { count: 1, floor: 40 }), ['surface:41']);
  assert.deepEqual(await command(run, 'surface_reserve_ids', { count: 1, floor: 3 }), ['surface:42']);
});

test('a restart never re-mints an id an earlier run handed out', async t => {
  const f = await fixture(t);
  const first = await f.start().ready();
  assert.deepEqual(await command(first, 'surface_reserve_ids', { count: 2, floor: 0 }), ['surface:1', 'surface:2']);
  assert.deepEqual(await command(first, 'workspace_reserve_ids', { count: 1 }), ['workspace:2']);
  await command(first, 'workspace_report', { entries: [{ id: 'workspace:9', name: 'Gone later', active: true }] });
  await first.stop();
  // The page restored nothing above surface:1: surface:2 was killed before the restart.
  const second = await f.start().ready();
  assert.deepEqual(await command(second, 'surface_reserve_ids', { count: 1, floor: 1 }), ['surface:3']);
  assert.deepEqual(await command(second, 'workspace_reserve_ids', { count: 1 }), ['workspace:10']);
});
