const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');

// Exercise the shipped shutdown function without starting PTYs or a sidecar.
const source = readFileSync(require.resolve('./main.js'), 'utf8');
const shutdownSource = source.slice(source.indexOf('let shuttingDown = false;'), source.indexOf("rl.on('close', shutdown)"));
// The browser host's own close waits for every provider it loaded
// (`createBrowserHost` in lib/src/host/browser-host.ts); here it is one call.
function fixture() {
  const calls = [];
  let closeBrowsers, deadline;
  const shutdown = runInNewContext(`${shutdownSource}\nshutdown`, {
    Promise,
    browserHost: { close: () => new Promise(resolve => { closeBrowsers = resolve; }) },
    setTimeout: callback => { deadline = callback; return { unref() {} }; },
    dorControl: { close: () => calls.push('control') },
    host: { dispose: () => calls.push('host') },
    mgr: { killAll: () => calls.push('ptys') },
    process: { exit: () => calls.push('exit') },
  });
  return { calls, shutdown, closeBrowsers: () => closeBrowsers(), deadline: () => deadline() };
}

test('shutdown waits for the browser host before tearing down the sidecar', async () => {
  const f = fixture();
  const done = f.shutdown();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, []);
  f.closeBrowsers();
  await done;
  assert.deepEqual(f.calls, ['control', 'host', 'ptys', 'exit']);
  await f.shutdown();
  assert.equal(f.calls.filter(call => call === 'exit').length, 1);
});

test('the shared deadline still permits shutdown when a browser provider hangs', async () => {
  const f = fixture();
  const done = f.shutdown();
  f.deadline();
  await done;
  assert.deepEqual(f.calls, ['control', 'host', 'ptys', 'exit']);
});
