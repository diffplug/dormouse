const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');

const { createDorControlServer, serverTimeoutFor } = require('./dor-control-server');

function testSocketPath(name) {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\dormouse-${name}-${suffix}`;
  }
  return path.join('/tmp', `dormouse-${name}-${suffix}.sock`);
}

function sendSocketRequest(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = '';

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
    });
    socket.on('end', () => {
      try {
        resolve(JSON.parse(buffer.trim()));
      } catch (error) {
        reject(error);
      }
    });
    socket.on('error', reject);
  });
}

/** Write a request and hand back the live socket, so a test can hang up on it. */
function openSocketRequest(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    socket.setEncoding('utf8');
    socket.on('error', reject);
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(payload)}\n`);
      resolve(socket);
    });
  });
}

function waitFor(predicate, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

test('server deadline outlasts the maximum accepted await timeout', () => {
  const hostTimeoutMs = 24 * 60 * 60 * 1000;
  const clientTimeoutMs = hostTimeoutMs + 5000;
  const serverTimeoutMs = serverTimeoutFor(clientTimeoutMs, 65000);

  assert.equal(serverTimeoutMs, clientTimeoutMs + 10000);
  assert.ok(hostTimeoutMs < clientTimeoutMs);
  assert.ok(clientTimeoutMs < serverTimeoutMs);
  assert.equal(serverTimeoutFor(clientTimeoutMs + 1, 65000), 65000);
});

test('dor control server forwards valid requests and writes responses', async () => {
  const socketPath = testSocketPath('control');
  const sent = [];
  let resolveSent;
  const firstSent = new Promise((resolve) => {
    resolveSent = resolve;
  });
  const server = createDorControlServer({
    socketPath,
    token: 'secret',
    send(event, data) {
      sent.push({ event, data });
      resolveSent();
    },
  });

  assert.ok(server);
  await server.ready;

  try {
    const responsePromise = sendSocketRequest(socketPath, {
      requestId: 'request-1',
      token: 'secret',
      surfaceId: 'pane-1',
      method: 'surface.list',
      params: { pane: 'focused' },
    });

    await firstSent;

    assert.deepEqual(sent, [{
      event: 'dor:controlRequest',
      data: {
        requestId: 'request-1',
        surfaceId: 'pane-1',
        method: 'surface.list',
        params: { pane: 'focused' },
      },
    }]);

    server.respond({
      requestId: 'request-1',
      ok: true,
      result: { surfaces: [] },
    });

    assert.deepEqual(await responsePromise, {
      requestId: 'request-1',
      ok: true,
      result: { surfaces: [] },
    });
  } finally {
    server.close();
  }
});

test('dor control server rejects invalid tokens', async () => {
  const socketPath = testSocketPath('token');
  const sent = [];
  const server = createDorControlServer({
    socketPath,
    token: 'secret',
    send(event, data) {
      sent.push({ event, data });
    },
  });

  assert.ok(server);
  await server.ready;

  try {
    const response = await sendSocketRequest(socketPath, {
      requestId: 'request-1',
      token: 'wrong',
      method: 'surface.list',
    });

    assert.deepEqual(sent, []);
    assert.deepEqual(response, {
      requestId: 'request-1',
      ok: false,
      error: 'invalid Dormouse control token',
    });
  } finally {
    server.close();
  }
});

test('dor control server rejects a missing (non-string) token', async () => {
  const socketPath = testSocketPath('token-missing');
  const sent = [];
  const server = createDorControlServer({
    socketPath,
    token: 'secret',
    send(event, data) {
      sent.push({ event, data });
    },
  });

  assert.ok(server);
  await server.ready;

  try {
    const response = await sendSocketRequest(socketPath, {
      requestId: 'request-1',
      method: 'surface.list',
    });

    assert.deepEqual(sent, []);
    assert.deepEqual(response, {
      requestId: 'request-1',
      ok: false,
      error: 'invalid Dormouse control token',
    });
  } finally {
    server.close();
  }
});

test('dor control server cancels a pending request when the client disconnects', async () => {
  const socketPath = testSocketPath('cancel-close');
  const sent = [];
  const server = createDorControlServer({
    socketPath,
    token: 'secret',
    send(event, data) {
      sent.push({ event, data });
    },
  });

  assert.ok(server);
  await server.ready;

  try {
    const socket = await openSocketRequest(socketPath, {
      requestId: 'request-1',
      token: 'secret',
      method: 'surface.await',
    });
    await waitFor(() => sent.some((entry) => entry.event === 'dor:controlRequest'), 'the forwarded request');

    // The client gives up (timeout / Ctrl-C) before the webview ever answers.
    socket.destroy();

    await waitFor(() => sent.some((entry) => entry.event === 'dor:controlCancel'), 'the cancel');
    assert.deepEqual(
      sent.filter((entry) => entry.event === 'dor:controlCancel'),
      [{ event: 'dor:controlCancel', data: { requestId: 'request-1' } }],
    );

    // The entry is gone, so a late webview answer is a silent no-op.
    server.respond({ requestId: 'request-1', ok: true, result: {} });
  } finally {
    server.close();
  }
});

test('dor control server cancels a pending request when its own timeout fires', async () => {
  const socketPath = testSocketPath('cancel-timeout');
  const sent = [];
  const server = createDorControlServer({
    socketPath,
    token: 'secret',
    timeoutMs: 30,
    send(event, data) {
      sent.push({ event, data });
    },
  });

  assert.ok(server);
  await server.ready;

  try {
    const response = await sendSocketRequest(socketPath, {
      requestId: 'request-1',
      token: 'secret',
      method: 'surface.list',
    });

    assert.deepEqual(response, {
      requestId: 'request-1',
      ok: false,
      error: 'timed out waiting for surface.list',
    });

    await waitFor(() => sent.some((entry) => entry.event === 'dor:controlCancel'), 'the cancel');
    // The socket close that follows the timeout response must not cancel twice.
    await delay(30);
    assert.deepEqual(
      sent.filter((entry) => entry.event === 'dor:controlCancel'),
      [{ event: 'dor:controlCancel', data: { requestId: 'request-1' } }],
    );
  } finally {
    server.close();
  }
});

test('a request timeoutMs stretches the server deadline past the option default', async () => {
  const socketPath = testSocketPath('deadline-stretch');
  const sent = [];
  const server = createDorControlServer({
    socketPath,
    token: 'secret',
    timeoutMs: 50,
    send(event, data) {
      sent.push({ event, data });
    },
  });

  assert.ok(server);
  await server.ready;

  try {
    const socket = await openSocketRequest(socketPath, {
      requestId: 'request-1',
      token: 'secret',
      method: 'surface.await',
      timeoutMs: 200,
    });
    await waitFor(() => sent.some((entry) => entry.event === 'dor:controlRequest'), 'the forwarded request');

    // Well past the 50ms option default. The real timer is 200 + 10_000, so the
    // only thing worth asserting is that it has not fired.
    await delay(100);
    assert.deepEqual(sent.filter((entry) => entry.event === 'dor:controlCancel'), []);
    assert.ok(!socket.destroyed, 'server must not have answered or hung up');

    socket.destroy();
    await waitFor(() => sent.some((entry) => entry.event === 'dor:controlCancel'), 'the cancel');
  } finally {
    server.close();
  }
});

for (const bogus of ['soon', -1, 0, Infinity, NaN, null]) {
  test(`a nonsense request timeoutMs (${String(bogus)}) falls back to the default deadline`, async () => {
    const socketPath = testSocketPath('deadline-bogus');
    const sent = [];
    const server = createDorControlServer({
      socketPath,
      token: 'secret',
      timeoutMs: 30,
      send(event, data) {
        sent.push({ event, data });
      },
    });

    assert.ok(server);
    await server.ready;

    try {
      const response = await sendSocketRequest(socketPath, {
        requestId: 'request-1',
        token: 'secret',
        method: 'surface.list',
        timeoutMs: bogus,
      });

      assert.deepEqual(response, {
        requestId: 'request-1',
        ok: false,
        error: 'timed out waiting for surface.list',
      });
      await waitFor(() => sent.some((entry) => entry.event === 'dor:controlCancel'), 'the cancel');
    } finally {
      server.close();
    }
  });
}
