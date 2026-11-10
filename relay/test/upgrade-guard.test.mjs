/**
 * No WebSocket-upgrade request, however malformed or abandoned, may end the
 * Relay process: it holds every session, challenge, and route in memory.
 * Spawns the real entrypoint and writes raw requests with `node:net`, since
 * neither `fetch` nor a WebSocket client will send these.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';

import { startRelay } from './spawn-relay.mjs';

function upgradeRequest(target) {
  return (
    `GET ${target} HTTP/1.1\r\nHost: test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
    'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'
  );
}

/** Send one upgrade request; `onData` decides what happens once an answer arrives. */
function sendUpgrade(port, target, onData) {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(upgradeRequest(target)));
    socket.on('error', () => resolve());
    socket.on('close', () => resolve());
    socket.once('data', () => onData(socket));
  });
}

/** Give a crash time to land, then assert the child is alive and serving. */
async function assertAlive(child, port) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(child.exitCode, null, 'the relay process must not exit');
  const res = await fetch(`http://127.0.0.1:${port}/api/hello`);
  assert.equal(res.status, 200);
}

test('an upgrade request whose target is not a parseable URL does not end the relay', async (t) => {
  const { child, port, stop } = await startRelay();
  t.after(stop);

  // `//` throws in `new URL('//', base)`; so would `//[` or `http://`.
  await new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(upgradeRequest('//')));
    socket.on('error', () => resolve());
    socket.on('close', () => resolve());
    setTimeout(() => {
      socket.destroy();
      resolve();
    }, 500);
  });
  await assertAlive(child, port);
});

test('a peer reset on a refused upgrade does not end the relay', async (t) => {
  const { child, port, stop } = await startRelay();
  t.after(stop);

  // No token: answered 401, and the socket is left to the peer. A reset after
  // the answer surfaces as ECONNRESET on the Relay's side of that socket.
  for (let i = 0; i < 5 && child.exitCode === null; i += 1) {
    await sendUpgrade(port, '/ws/client', (socket) => socket.resetAndDestroy());
  }
  await assertAlive(child, port);
});
