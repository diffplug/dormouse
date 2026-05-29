const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');

const { createDorControlServer } = require('./dor-control-server');

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
