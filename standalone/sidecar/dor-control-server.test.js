const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const {
  createDorControlServer,
  ensureControlDir,
  resolveControlSocketPath,
  proveToken,
  CLIENT_PROOF_DOMAIN,
  SERVER_PROOF_DOMAIN,
} = require('./dor-control-server');

function testSocketPath(name) {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\dormouse-${name}-${suffix}`;
  }
  return path.join('/tmp', `dormouse-${name}-${suffix}.sock`);
}

/**
 * A `dor`-shaped client: read the challenge, answer it, verify the welcome, and
 * only then send the request. `hello`/`request` overrides let a test play the
 * peer that gets the handshake wrong.
 */
function sendSocketRequest(socketPath, request, options = {}) {
  const { token = 'secret', hello, expectLines = 3 } = options;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const nonce = 'client-nonce';
    const lines = [];
    let buffer = '';

    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        lines.push(JSON.parse(line));
        if (lines.length === 1) {
          socket.write(`${JSON.stringify(hello ?? {
            kind: 'hello',
            nonce,
            proof: proveToken(token, CLIENT_PROOF_DOMAIN, lines[0].nonce),
          })}\n`);
        } else if (lines.length === 2 && request) {
          socket.write(`${JSON.stringify(request)}\n`);
        }
        if (lines.length >= expectLines) {
          resolve({ lines, nonce, closed: false });
          socket.destroy();
          return;
        }
        index = buffer.indexOf('\n');
      }
    });
    socket.on('close', () => resolve({ lines, nonce, closed: true }));
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
  assert.equal(server.socketPath, socketPath);
  await server.ready;

  try {
    const exchange = sendSocketRequest(socketPath, {
      requestId: 'request-1',
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

    const { lines, nonce } = await exchange;
    assert.equal(lines[0].kind, 'challenge');
    // The server proves itself over the nonce the *client* chose, so a squatter
    // that merely bound the path cannot fake this half.
    assert.deepEqual(lines[1], {
      kind: 'welcome',
      proof: proveToken('secret', SERVER_PROOF_DOMAIN, nonce),
    });
    assert.deepEqual(lines[2], {
      requestId: 'request-1',
      ok: true,
      result: { surfaces: [] },
    });
  } finally {
    server.close();
  }
});

test('dor control server speaks first and never sees the raw token', async () => {
  const socketPath = testSocketPath('challenge');
  const server = createDorControlServer({ socketPath, token: 'secret', send() {} });
  assert.ok(server);
  await server.ready;

  try {
    const received = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: socketPath });
      socket.setEncoding('utf8');
      // Say nothing at all — a squatter's whole hope is that the client
      // volunteers the token on connect.
      socket.on('data', (chunk) => {
        resolve(chunk);
        socket.destroy();
      });
      socket.on('error', reject);
    });

    const frame = JSON.parse(received.trim());
    assert.equal(frame.kind, 'challenge');
    assert.match(frame.nonce, /^[0-9a-f]{32}$/);
    assert.ok(!received.includes('secret'));
  } finally {
    server.close();
  }
});

test('dor control server hangs up on a client that cannot prove the token', async () => {
  const socketPath = testSocketPath('bad-hello');
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
    const { lines, closed } = await sendSocketRequest(
      socketPath,
      { requestId: 'request-1', method: 'surface.list' },
      { token: 'wrong' },
    );

    assert.equal(closed, true);
    // Challenge only: no welcome, no response, and nothing reached the webview.
    assert.equal(lines.length, 1);
    assert.equal(lines[0].kind, 'challenge');
    assert.deepEqual(sent, []);
  } finally {
    server.close();
  }
});

test('dor control server hangs up on a hello that is not a hello', async () => {
  const socketPath = testSocketPath('no-hello');
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
    // The pre-handshake wire shape: a request that carries the token the way the
    // old protocol did must not be honoured.
    const { lines, closed } = await sendSocketRequest(socketPath, null, {
      hello: { requestId: 'request-1', token: 'secret', method: 'surface.list' },
    });

    assert.equal(closed, true);
    assert.equal(lines.length, 1);
    assert.deepEqual(sent, []);
  } finally {
    server.close();
  }
});

test('dor control server refuses to start without a token', () => {
  assert.equal(createDorControlServer({ token: '', send() {} }), null);
  assert.equal(createDorControlServer({ token: undefined, send() {} }), null);
});

test('the chosen socket path is unguessable and, on POSIX, privately owned', { skip: process.platform === 'win32' }, () => {
  const productionPath = resolveControlSocketPath();
  assert.ok(productionPath);
  // macOS caps sun_path near 104 bytes, and it is the platform with no slack:
  // its os.tmpdir() is a ~48-byte per-user path where CI's Linux `/tmp` is 4.
  // Check the production spelling under both, or a name that grows by 20 bytes
  // passes here and fails to bind on a Mac. The isolated directory below is
  // intentionally different and must not make this depend on a test-only
  // prefix, the PID, or Math.random's variable-length rendering.
  for (const tmp of [os.tmpdir(), `/var/folders/ab/${'c'.repeat(30)}/T`]) {
    const candidate = path.join(tmp, path.relative(os.tmpdir(), productionPath));
    assert.ok(
      Buffer.byteLength(candidate) < 104,
      `${candidate} is ${Buffer.byteLength(candidate)} bytes`,
    );
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dor-test-'));
  try {
    const first = resolveControlSocketPath(dir);
    const second = resolveControlSocketPath(dir);
    assert.ok(first);
    // A PID-derived name is enumerable; two draws must not collide.
    assert.notEqual(first, second);
    assert.equal(path.dirname(first), dir);
    assert.match(path.basename(first), /^[0-9a-f]{16}\.sock$/);
    assert.equal(fs.lstatSync(dir).mode & 0o777, 0o700);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a loosely-permissioned directory of ours is tightened rather than used as-is', { skip: process.platform === 'win32' }, () => {
  const dir = path.join(os.tmpdir(), `dormouse-dor-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o777 });
  fs.chmodSync(dir, 0o777);
  try {
    assert.equal(ensureControlDir(dir), dir);
    assert.equal(fs.lstatSync(dir).mode & 0o777, 0o700);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a socket directory that is not a directory of ours is refused', { skip: process.platform === 'win32' }, () => {
  const dir = path.join(os.tmpdir(), `dormouse-dor-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  // A symlink is the shape an attacker plants to redirect the bind elsewhere;
  // `mkdir -p` succeeds through it, so only the lstat catches it.
  fs.mkdirSync(`${dir}-target`, { recursive: true, mode: 0o700 });
  fs.symlinkSync(`${dir}-target`, dir);
  try {
    assert.equal(ensureControlDir(dir), null);
    assert.equal(resolveControlSocketPath(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(`${dir}-target`, { recursive: true, force: true });
  }
});

test('a control server that cannot get a private directory reports a dead channel', { skip: process.platform === 'win32' }, async () => {
  const dir = path.join(os.tmpdir(), `dormouse-dor-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(`${dir}-target`, { recursive: true, mode: 0o700 });
  fs.symlinkSync(`${dir}-target`, dir);
  try {
    const server = createDorControlServer({ socketDir: dir, token: 'secret', send() {} });
    assert.ok(server);
    // No path at all — the caller has nothing to put in a shell's environment,
    // which is the point: no bind, no token handout.
    assert.equal(server.socketPath, null);
    await assert.rejects(server.ready, /not a private directory/);
    server.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(`${dir}-target`, { recursive: true, force: true });
  }
});

test('a lost bind is fatal to the channel, not to the host', { skip: process.platform === 'win32' }, async () => {
  // A path under a directory that does not exist: `listen` fails the way a
  // squatted Windows pipe name does, and the constructor must survive it — a
  // throw here would take the sidecar and every PTY in it down.
  const socketPath = path.join(os.tmpdir(), `dormouse-dor-missing-${process.pid}`, 'control.sock');
  const server = createDorControlServer({ socketPath, token: 'secret', send() {} });
  assert.ok(server);
  await assert.rejects(server.ready);
  server.close();
});
