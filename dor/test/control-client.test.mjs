import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { SocketControlClient } from '../dist/control-client.js';

// The other half of the handshake, exactly as both hosts load it.
const require = createRequire(import.meta.url);
const { createDorControlServer } = require('../../standalone/sidecar/dor-control-server.js');

const skipOnWindows = { skip: process.platform === 'win32' ? 'unix sockets only' : false };

async function withTempSocket(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dor-control-'));
  try {
    return await run(join(dir, 'control.sock'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a dor client and the host control server complete a request', skipOnWindows, async () => {
  await withTempSocket(async (socketPath) => {
    const forwarded = [];
    const server = createDorControlServer({
      socketPath,
      token: 'shared-secret',
      send(event, data) {
        forwarded.push({ event, data });
        server.respond({ requestId: data.requestId, ok: true, result: { surfaces: [] } });
      },
    });
    await server.ready;
    try {
      const client = new SocketControlClient({
        socketPath,
        token: 'shared-secret',
        surfaceId: 'surface-1',
        timeoutMs: 5000,
      });
      assert.deepEqual(await client.listSurfaces({}), { surfaces: [] });
      assert.equal(forwarded.length, 1);
      assert.equal(forwarded[0].data.surfaceId, 'surface-1');
      assert.equal(forwarded[0].data.method, 'surface.list');
    } finally {
      server.close();
    }
  });
});

test('a dor client refuses a host whose token does not match', skipOnWindows, async () => {
  await withTempSocket(async (socketPath) => {
    const server = createDorControlServer({ socketPath, token: 'shared-secret', send() {} });
    await server.ready;
    try {
      const client = new SocketControlClient({ socketPath, token: 'wrong-secret', timeoutMs: 5000 });
      await assert.rejects(client.listSurfaces({}), /could not prove it is Dormouse/);
    } finally {
      server.close();
    }
  });
});

// The reason the handshake exists: whoever holds the socket path used to receive
// DORMOUSE_CONTROL_TOKEN as the first bytes of the first `dor` invocation, and
// that token grants the whole surface API (`send` types into any pane, `read`
// returns its scrollback).
test('a squatter that cannot prove the token never receives it', skipOnWindows, async () => {
  await withTempSocket(async (socketPath) => {
    const received = [];
    const squatter = createServer((socket) => {
      socket.setEncoding('utf8');
      socket.on('error', () => {});
      // Play the part convincingly: a challenge, then a welcome whose proof is
      // the best a peer without the token can do. The welcome waits for the
      // hello rather than a timer, so the client cannot reject before its hello
      // is in `received` — the client destroys the socket as it rejects, and a
      // hello still queued there never reaches the wire at all.
      let welcomed = false;
      socket.on('data', (chunk) => {
        received.push(chunk);
        if (welcomed || !received.join('').includes('\n')) return;
        welcomed = true;
        socket.write(`${JSON.stringify({ kind: 'welcome', proof: 'f'.repeat(64) })}\n`);
      });
      socket.write(`${JSON.stringify({ kind: 'challenge', nonce: 'attacker-nonce' })}\n`);
    });
    await new Promise((resolve) => squatter.listen(socketPath, resolve));
    try {
      const client = new SocketControlClient({ socketPath, token: 'shared-secret', timeoutMs: 5000 });
      await assert.rejects(client.listSurfaces({}), /could not prove it is Dormouse/);
      const wire = received.join('');
      // Every assertion below holds of an empty `wire`, so it observes nothing
      // about a leak until there is something to observe.
      assert.ok(wire.trim(), 'the squatter received nothing, so the assertions below prove nothing');
      assert.ok(!wire.includes('shared-secret'), `token leaked to the squatter: ${wire}`);
      // Only the hello — the request, with whatever it would have carried, was
      // never sent.
      assert.equal(received.join('').trim().split('\n').length, 1);
      assert.equal(JSON.parse(wire.trim()).kind, 'hello');
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }
  });
});

test('a peer that does not open with a challenge gets nothing at all', skipOnWindows, async () => {
  await withTempSocket(async (socketPath) => {
    const received = [];
    const squatter = createServer((socket) => {
      socket.setEncoding('utf8');
      socket.on('error', () => {});
      socket.on('data', (chunk) => received.push(chunk));
      socket.write(`${JSON.stringify({ ok: true, result: {} })}\n`);
    });
    await new Promise((resolve) => squatter.listen(socketPath, resolve));
    try {
      const client = new SocketControlClient({ socketPath, token: 'shared-secret', timeoutMs: 5000 });
      await assert.rejects(client.listSurfaces({}), /could not prove it is Dormouse/);
      // How much this proves: a client that wrote before validating the frame
      // would destroy the socket in the same turn and its bytes would never
      // reach the wire, so `received` would be empty either way. Nothing here
      // can wait for what is meant never to arrive; the test above is the one
      // that pins what a client sends a peer it cannot verify.
      assert.deepEqual(received, []);
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }
  });
});
