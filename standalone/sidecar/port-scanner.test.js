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

test('port scans batch callers and serialize work', async () => {
  const calls = [];
  const first = deferred();
  const scanner = createPortScanner((pids) => {
    calls.push(pids);
    return calls.length === 1 ? first.promise : Promise.resolve(new Map());
  });
  const a = scanner([10]);
  const b = scanner([10, 20]);
  await new Promise(setImmediate);
  assert.deepEqual(calls, [[10, 20]]);
  const c = scanner([30]);
  await new Promise(setImmediate);
  assert.equal(calls.length, 1);
  first.resolve(new Map([[10, ['port']]]));
  assert.deepEqual(await a, await b);
  await c;
  assert.deepEqual(calls, [[10, 20], [30]]);
});

test('a failed scan answers empty and releases the next batch', async () => {
  const first = deferred();
  let calls = 0;
  const scanner = createPortScanner(() => ++calls === 1 ? first.promise : new Map([[20, []]]));
  const a = scanner([10]);
  await new Promise(setImmediate);
  const b = scanner([20]);
  first.reject(new Error('scan failed'));
  assert.deepEqual(await a, new Map());
  assert.deepEqual(await b, new Map([[20, []]]));
});

test('empty requests never scan', async () => {
  const scanner = createPortScanner(() => assert.fail('unexpected scan'));
  assert.deepEqual(await scanner([]), new Map());
});

test('a real scan discovers a listener while the event loop keeps running', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    let ticked = false;
    const timer = setTimeout(() => { ticked = true; }, 0);
    const ports = await createPortScanner(getOpenPortsForPids)([process.pid]);
    clearTimeout(timer);
    assert.equal(ticked, true);
    assert.ok(ports.get(process.pid)?.some((p) => p.port === server.address().port));
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
