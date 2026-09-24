const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');

// Exercise the shipped shutdown function without starting PTYs or a sidecar.
const source = readFileSync(require.resolve('./main.js'), 'utf8');
const shutdownSource = source.slice(source.indexOf('let shuttingDown = false;'), source.indexOf("rl.on('close', shutdown)"));
function fixture() {
  const calls = [];
  let closeAgent, closePlaywright, deadline;
  const shutdown = runInNewContext(`${shutdownSource}\nshutdown`, {
    Promise,
    agentBrowser: { closePoppedOut: () => new Promise(resolve => { closeAgent = resolve; }) },
    playwright: { close: () => new Promise(resolve => { closePlaywright = resolve; }) },
    setTimeout: callback => { deadline = callback; return { unref() {} }; },
    dorControl: { close: () => calls.push('control') },
    alertStore: { dispose: () => calls.push('alerts') },
    burrow: { dispose: () => calls.push('burrow') },
    mgr: { killAll: () => calls.push('ptys') },
    process: { exit: () => calls.push('exit') },
  });
  return { calls, shutdown, closeAgent: () => closeAgent(), closePlaywright: () => closePlaywright(), deadline: () => deadline() };
}

test('shutdown waits for both browser providers before tearing down the sidecar', async () => {
  const f = fixture();
  const done = f.shutdown();
  f.closeAgent();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, []);
  f.closePlaywright();
  await done;
  assert.deepEqual(f.calls, ['control', 'alerts', 'burrow', 'ptys', 'exit']);
  await f.shutdown();
  assert.equal(f.calls.filter(call => call === 'exit').length, 1);
});

test('the shared deadline still permits shutdown when a browser provider hangs', async () => {
  const f = fixture();
  const done = f.shutdown();
  f.closePlaywright();
  f.deadline();
  await done;
  assert.deepEqual(f.calls, ['control', 'alerts', 'burrow', 'ptys', 'exit']);
});
