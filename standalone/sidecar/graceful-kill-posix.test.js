const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { existsSync, mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { create } = require('./pty-core');

// The POSIX graceful stop on a real interactive bash under the pinned node-pty
// (docs/specs/transport.md -> Graceful shutdown): the hangup ends a shell at
// once, and a shell that ignores it is killed at the deadline.
const BASH = process.platform === 'win32' ? null
  : ['/bin/bash', '/usr/bin/bash'].find((candidate) => existsSync(candidate)) ?? null;

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const children = (pid) => {
  const found = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
  return found.stdout.split('\n').filter(Boolean).map(Number);
};
const until = async (predicate, what, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** An integrated interactive bash in a bare home, typing `line` once it is up;
 *  answers its pid. It, and each pid passed to `leaves`, is killed after the test. */
async function shell(t, line) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dormouse-graceful-'));
  const events = [];
  let output = '';
  const mgr = create((event, data) => {
    events.push({ event, data });
    if (event === 'data') output += data.data;
  }, require('node-pty'));
  const pids = [];
  t.after(() => {
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
    mgr.killAll();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  mgr.spawn('sh', {
    shell: BASH, args: ['-i'], cwd: home,
    env: { HOME: home, PATH: process.env.PATH, TERM: 'xterm-256color' },
  });
  mgr.write('sh', `echo PID=$$; ${line}\r`);
  await until(() => /PID=(\d+)\r?\n/.test(output), 'the shell to print its pid');
  const pid = Number(/PID=(\d+)\r?\n/.exec(output)[1]);
  pids.push(pid);
  const stop = (timeout) => new Promise((resolve) => {
    const started = Date.now();
    const length = events.length;
    const check = setInterval(() => {
      if (!events.slice(length).some(({ event }) => event === 'gracefulKillDone')) return;
      clearInterval(check);
      resolve(Date.now() - started);
    }, 10);
    mgr.gracefulKill(['sh'], timeout, 'r');
  });
  return { mgr, events, pid, stop, leaves: (more) => pids.push(...more) };
}

test('a graceful stop ends an interactive shell at once, not at the deadline', {
  skip: !BASH, timeout: 15_000,
}, async (t) => {
  const { mgr, events, pid, stop } = await shell(t, 'true');
  const waited = await stop(2_000);
  assert.ok(events.some(({ event, data }) => event === 'exit' && data.id === 'sh'), 'the shell exits');
  assert.equal(mgr.hasPty('sh'), false);
  assert.ok(waited < 1_000, `acknowledged after ${waited} ms`);
  assert.equal(alive(pid), false);
});

test('a graceful stop kills a shell that ignores the hangup once the deadline passes', {
  skip: !BASH, timeout: 15_000,
}, async (t) => {
  const { mgr, events, pid, stop, leaves } = await shell(t, "trap '' HUP; sleep 600");
  await until(() => children(pid).length > 0, 'the foreground sleep');
  // The sleep inherits the ignored hangup and outlives its shell.
  leaves(children(pid));
  await stop(300);
  await until(() => !alive(pid), 'the shell to die', 2_000);
  assert.ok(events.some(({ event, data }) => event === 'exit' && data.id === 'sh'), 'its exit reaches the host');
  assert.equal(mgr.hasPty('sh'), false);
});
