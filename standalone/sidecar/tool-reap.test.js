// A reap and rehydrate on a real PTY (docs/specs/dor-tool.md -> Reaping): the
// PTY core's spawn, the shipped bash integration, and a real Tool process. The
// renderer half — when to stop, which payload counts, the bare-args retry — is
// pinned by lib/src/components/wall/tool-reaper.test.ts; this pins what only a
// real shell shows: Ctrl+C reaching the Tool through the line discipline, the
// payload arriving in its environment, and the integration unsetting it so no
// later command in that shell inherits it.
// CommonJS to match its siblings.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync, existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { create, DEHYDRATE_LIMIT } = require('./pty-core');

function findShell(name) {
  if (process.platform === 'win32') return null;
  const which = spawnSync('which', [name], { encoding: 'utf8' });
  const resolved = which.status === 0 ? which.stdout.split('\n')[0].trim() : '';
  return resolved && existsSync(resolved) ? resolved : [`/bin/${name}`, `/usr/bin/${name}`].find((p) => existsSync(p)) ?? null;
}
const BASH = findShell('bash');
const ZSH = findShell('zsh');

// The Tool: declares itself safe to stop, prints the payload it was handed,
// and on Ctrl+C emits its state, counting the stops it has been through. It
// reads the payload as `readDehydrated` does: anything else is none.
const TOOL = `
const raw = process.env.DORMOUSE_DEHYDRATE;
let handed = null;
try { const parsed = JSON.parse(raw); if (parsed && parsed.v === 1 && parsed.state != null) handed = parsed.state; } catch {}
const state = handed ?? { stops: 0 };
process.stdout.write('\\x1b]367;serve;{"dehydrate":true,"v":1}\\x07');
process.stdout.write('HANDED=' + JSON.stringify(handed) + '\\n');
process.on('SIGINT', () => {
  state.stops += 1;
  process.stdout.write('\\x1b]367;dehydrate;' + JSON.stringify({ v: 1, state }) + '\\x07');
  process.exit(0);
});
setInterval(() => {}, 1000);
`;

function session(shell = BASH) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dormouse-reap-'));
  writeFileSync(path.join(home, 'tool.js'), TOOL);
  let output = '';
  const waiters = new Set();
  const mgr = create((event, data) => {
    if (event !== 'data' || data.id !== 'tool') return;
    output += data.data;
    for (const waiter of waiters) waiter();
  }, require('node-pty'));
  /** Resolves once `predicate(output since mark)` holds. */
  const waitFor = (mark, predicate, what) => new Promise((resolve, reject) => {
    const check = () => {
      const seen = output.slice(mark);
      if (!predicate(seen)) return false;
      waiters.delete(check);
      clearTimeout(timer);
      resolve(seen);
      return true;
    };
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`no ${what}; tail: ${JSON.stringify(output.slice(-400))}`)); }, 15_000);
    waiters.add(check);
    check();
  });
  const prompts = (seen) => (seen.match(/\x1b\]633;A\x07[\s\S]*?\x1b\]633;B\x07/g) || []).length;
  return {
    home,
    mark: () => output.length,
    /** A fresh integrated bash under the Tool's id, as a rehydrate spawns it. */
    async spawn(dehydrate) {
      const mark = output.length;
      mgr.spawn('tool', {
        shell, args: ['-i'], cwd: home,
        // A bare home: the developer's profile stays out of the shell.
        env: { HOME: home, PATH: process.env.PATH, TERM: 'xterm-256color' },
        ...(dehydrate === undefined ? {} : { dehydrate }),
      });
      await waitFor(mark, (seen) => prompts(seen) >= 1, 'first prompt');
    },
    /** Type the Tool's command and wait for what it was handed. */
    async run() {
      const mark = output.length;
      mgr.write('tool', `node tool.js\r`);
      const seen = await waitFor(mark, (s) => /HANDED=.*\r?\n/.test(s), 'Tool start');
      return JSON.parse(/HANDED=(.*)\r?\n/.exec(seen)[1]);
    },
    /** Ctrl+C, the graceful-stop signal; the payload the Tool left, once the prompt is back. */
    async stop() {
      const mark = output.length;
      mgr.write('tool', '\x03');
      const seen = await waitFor(mark, (s) => prompts(s) >= 1, 'prompt after Ctrl+C');
      return /\x1b\]367;dehydrate;([^\x07]*)\x07/.exec(seen)?.[1] ?? null;
    },
    kill() { mgr.kill('tool'); },
    close() {
      mgr.killAll();
      // A dying zsh can still be writing its history into the bare home.
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

for (const [name, shell] of [['bash', BASH], ['zsh', ZSH]]) test(`${name}: a Tool stopped with Ctrl+C restarts with its payload, which no later command inherits`, { skip: !shell && `needs ${name}`, timeout: 60_000 }, async () => {
  const s = session(shell);
  try {
    // First boot: nothing handed, as a fresh `dor tool` launch.
    await s.spawn();
    assert.equal(await s.run(), null);
    const payload = await s.stop();
    assert.equal(payload, JSON.stringify({ v: 1, state: { stops: 1 } }));
    s.kill();

    // The rehydrate: a fresh shell carrying the payload to its first command.
    await s.spawn(payload);
    assert.deepEqual(await s.run(), { stops: 1 });
    assert.equal(await s.stop(), JSON.stringify({ v: 1, state: { stops: 2 } }));
    // The bare-args retry, or any later command in this shell, runs without it.
    assert.equal(await s.run(), null);
    await s.stop();
  } finally {
    s.close();
  }
});

test('a missing, garbage, or oversized payload restarts the Tool from its args', { skip: !BASH && 'needs bash', timeout: 60_000 }, async () => {
  const s = session();
  try {
    for (const dehydrate of [undefined, 'not json', JSON.stringify({ v: 1, state: 'x'.repeat(DEHYDRATE_LIMIT) })]) {
      await s.spawn(dehydrate);
      assert.equal(await s.run(), null, `handed for ${String(dehydrate).slice(0, 20)}`);
      await s.stop();
      s.kill();
    }
  } finally {
    s.close();
  }
});
