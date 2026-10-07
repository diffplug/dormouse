const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { create } = require('./pty-core');

// Run against the pinned addon and bundled ConPTY, not a fake. WindowsTerminal
// defers kill until its first data event, so cover shutdown before readiness as
// well as after it. A second cleanup can race the asynchronous exit callback.
for (const phase of ['ready', 'before ready', 'cleanup during close']) {
  test(`Windows ConPTY shutdown: ${phase}`, {
    skip: process.platform !== 'win32', timeout: 15_000,
  }, async (t) => {
    const events = [];
    let readyResolve, doneResolve, exitResolve;
    const ready = new Promise(resolve => { readyResolve = resolve; });
    const done = new Promise(resolve => { doneResolve = resolve; });
    const exited = new Promise(resolve => { exitResolve = resolve; });
    const mgr = create((event, data) => {
      events.push({ event, data });
      if (event === 'data') readyResolve();
      if (event === 'gracefulKillDone') doneResolve();
      if (event === 'exit') exitResolve();
    }, require('node-pty'));
    t.after(() => mgr.killAll());
    mgr.spawn('probe', { shell: path.join(process.env.SystemRoot, 'System32', 'cmd.exe'), args: ['/d'] });
    if (phase !== 'before ready') await ready;
    const started = Date.now();
    mgr.gracefulKill(['probe'], 60_000, 'native-close');
    if (phase === 'cleanup during close') mgr.killAll();
    await done;
    assert.ok(Date.now() - started < 5_000, 'must finish before the 60s deadline');
    assert.equal(mgr.hasPty('probe'), false);
    if (phase !== 'cleanup during close') assert.ok(events.some(({ event }) => event === 'exit'));
    assert.deepEqual(events.at(-1), { event: 'gracefulKillDone', data: { requestId: 'native-close' } });
    // Explicit cleanup removes the map entry before native exit; still join
    // that exit so --test-force-exit cannot hide a stuck native process.
    await exited;
    // Both hosts run a later cleanup pass after the graceful acknowledgement.
    assert.doesNotThrow(() => mgr.killAll());
  });
}
