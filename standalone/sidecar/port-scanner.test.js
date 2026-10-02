const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { createPortScanner } = require('./port-scanner');
const { getOpenPortsForPids } = require('./pty-core');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('requests in one microtask share one scan budgeted for the smallest request', async () => {
  const calls = [];
  const scanner = createPortScanner((pids, count) => {
    calls.push({ pids, count });
    return Promise.resolve(new Map([[10, ['port']]]));
  });
  const a = scanner([10]);
  const b = scanner([10, 20]);
  assert.deepEqual(await a, await b);
  assert.deepEqual(calls, [{ pids: [10, 20], count: 1 }]);
});

test('a request during a scan starts its own rather than queueing behind it', async () => {
  const calls = [];
  const first = deferred();
  const scanner = createPortScanner((pids) => {
    calls.push(pids);
    return calls.length === 1 ? first.promise : Promise.resolve(new Map([[30, []]]));
  });
  const a = scanner([10]);
  await new Promise(setImmediate);
  assert.deepEqual(await scanner([30]), new Map([[30, []]]));
  assert.deepEqual(calls, [[10], [30]]);
  first.resolve(new Map());
  await a;
});

test('a failed scan answers empty', async () => {
  const scanner = createPortScanner(() => Promise.reject(new Error('scan failed')));
  assert.deepEqual(await scanner([10]), new Map());
});

test('empty requests never scan', async () => {
  const scanner = createPortScanner(() => assert.fail('unexpected scan'));
  assert.deepEqual(await scanner([]), new Map());
});

test('a real scan discovers a listener, yielding to the event loop where it spawns', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    let ticked = false;
    const timer = setTimeout(() => { ticked = true; }, 0);
    const ports = await createPortScanner((pids) => getOpenPortsForPids(pids))([process.pid]);
    clearTimeout(timer);
    // Linux reads /proc synchronously (no subprocess), so only spawning scans yield.
    if (process.platform !== 'linux') assert.equal(ticked, true);
    assert.ok(ports.get(process.pid)?.some((p) => p.port === server.address().port));
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
