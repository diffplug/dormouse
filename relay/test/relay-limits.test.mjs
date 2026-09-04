/**
 * What bounds a relay socket (docs/specs/relay.md -> Relay).
 *
 * The frame gates and routing rules live in `relay.test.mjs`; these are the
 * resource bounds around them — how many Client sockets exist, how large a
 * frame may be before any guard runs, and the two reasons a socket that passed
 * the upgrade is closed afterwards. The upgrade check runs exactly once, which
 * is why the sweep exists at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WS_ROUTES, WS_TOKEN_PARAM } from 'remote-lib-common';

import { MAX_RELAY_FRAME_BYTES } from '../dist/app.js';
import { MAX_RELAY_CLIENT_SOCKETS } from '../dist/relay.js';

import {
  connectClient,
  connectBurrow,
  freshApp,
  makeClock,
  ownerSession,
  startRelay,
  until,
  wsConnect,
} from './helpers.mjs';
import { e2eClientFrame, newE2eId } from './harness/e2e.mjs';
import { recordingSocket } from './harness/memory-socket.mjs';

/** A live Relay plus a signed-in owner; the session token is reused per socket. */
async function relayApp(options = {}) {
  const created = await freshApp(options);
  const server = await startRelay(created);
  const { sessionToken } = await ownerSession(created.app);
  const open = () =>
    wsConnect(`${server.wsUrl}${WS_ROUTES.client}?${WS_TOKEN_PARAM}=${sessionToken}`);
  return { ...created, server, sessionToken, open };
}

test('client sockets are capped, and the refusal is a retry rather than an eviction', async (t) => {
  const { hub, server, open } = await relayApp();
  t.after(() => server.close());

  const sockets = [];
  for (let i = 0; i < MAX_RELAY_CLIENT_SOCKETS; i += 1) {
    const socket = open();
    await socket.ready;
    sockets.push(socket);
  }
  assert.equal(hub.clientCount, MAX_RELAY_CLIENT_SOCKETS);

  // One past the cap: the upgrade succeeds (the session is valid) and the
  // socket is closed immediately with "try again later".
  const refused = open();
  const closed = await refused.closed;
  assert.equal(closed.code, 1013);
  // The sockets already relaying are untouched — dropping one to admit another
  // would let a token holder take the relay away from itself.
  assert.equal(hub.clientCount, MAX_RELAY_CLIENT_SOCKETS);

  for (const socket of sockets) socket.close();
});

test('a frame larger than any legal one is refused by the socket, not buffered', async (t) => {
  // `ws` defaults to 100 MiB, which the relay would buffer whole before
  // `isE2eClientFrame` ran. 1009 is the protocol's own "message too big".
  const { server, open } = await relayApp();
  t.after(() => server.close());

  const socket = open();
  await socket.ready;
  socket.ws.send('x'.repeat(MAX_RELAY_FRAME_BYTES + 1));

  const closed = await socket.closed;
  assert.equal(closed.code, 1009);
});

test('a maximal legal frame still fits under the cap', async (t) => {
  const { server, open } = await relayApp();
  t.after(() => server.close());

  const socket = open();
  await socket.ready;
  // Well-formed but addressed to no live Burrow, so the answer is the routing
  // error — which is the point: the frame was read rather than rejected by size.
  socket.send({
    t: 'e2e',
    burrowId: 'A'.repeat(22),
    kind: 'connection',
    id: 'B'.repeat(22),
    step: 'init',
    ct: 'C'.repeat(1024),
  });
  const frame = await socket.take();
  assert.equal(frame.t, 'error');
  socket.close();
});

test('a client socket whose session has expired is closed by the sweep', async (t) => {
  // The upgrade gate runs once. A socket opened a minute before a 12-hour
  // session expires would otherwise relay for the process lifetime.
  const clock = makeClock();
  const created = await freshApp({ now: clock.now });
  const server = await startRelay(created);
  t.after(() => server.close());
  const { socket } = await connectClient(created.app, server);

  // Not yet: a live session is left alone.
  assert.deepEqual(created.sweepRelaySockets(), { expired: 0, idle: 0 });
  assert.equal(created.hub.clientCount, 1);

  clock.advance(13 * 60 * 60 * 1000);
  assert.equal(created.sweepRelaySockets().expired, 1);

  const closed = await socket.closed;
  // The same code and reason the upgrade answers with, so Pocket needs no
  // second recovery path.
  assert.equal(closed.code, 1008);
  assert.equal(created.hub.clientCount, 0);
});

test('a socket that stops answering the heartbeat is closed; a live one is not', async (t) => {
  const clock = makeClock();
  const created = await freshApp({ now: clock.now });
  const server = await startRelay(created);
  t.after(() => server.close());
  const { socket } = await connectBurrow(created.app, server);
  await until(() => created.hub.onlineBurrowIds().length === 1);

  // Two sweeps at the same instant leave it alone: silence is not death.
  assert.equal(created.sweepRelaySockets().idle, 0);
  assert.equal(created.sweepRelaySockets().idle, 0);
  assert.equal(created.hub.onlineBurrowIds().length, 1);

  // Past the idle timeout with nothing heard from it since.
  clock.advance(10 * 60 * 1000);
  assert.equal(created.sweepRelaySockets().idle, 1);

  const closed = await socket.closed;
  assert.equal(closed.code, 1001);
});

test('the expiry sweep tells a Burrow client-gone exactly once', async () => {
  // The sweep tears down and THEN closes, so the socket's own `onClose` reaches
  // `unregisterClient` a second time. Driven at the hub rather than over a real
  // socket, because what needs proving is that the second call is a no-op, not
  // how long a close handshake takes.
  const { hub } = await freshApp();
  const burrowId = newE2eId();
  const burrowSocket = recordingSocket();
  hub.registerBurrow(burrowId, burrowSocket);
  const clientSocket = recordingSocket();
  const client = hub.registerClient(clientSocket, { expiresAt: 1000 });
  // `client-gone` only reaches a Burrow the client is bound to.
  hub.onClientFrame(client, JSON.stringify(e2eClientFrame(burrowId)));
  assert.equal(client.burrowId, burrowId, 'precondition: bound');

  assert.equal(hub.closeExpiredClients(1000), 1);
  assert.equal(clientSocket.closeCode, 1008);
  // What the socket's own `onClose` then does.
  hub.unregisterClient(client);

  assert.deepEqual(
    burrowSocket.sent.filter((frame) => frame.t === 'client-gone').length,
    1,
  );
});

test('a frame in flight when the sweep closed a socket reaches no Burrow', async () => {
  // `close()` starts a handshake rather than ending the socket, so a frame
  // already buffered still arrives carrying the torn-down conn. Forwarding it
  // would name a `clientId` the Burrow was just told was gone — and an `init`
  // would open a fresh ceremony for the session the sweep expired, which is
  // exactly what expiring it exists to stop.
  const { hub } = await freshApp();
  const burrowId = newE2eId();
  const burrowSocket = recordingSocket();
  hub.registerBurrow(burrowId, burrowSocket);
  const clientSocket = recordingSocket();
  const client = hub.registerClient(clientSocket, { expiresAt: 1000 });
  hub.onClientFrame(client, JSON.stringify(e2eClientFrame(burrowId)));
  assert.equal(burrowSocket.sent.at(-1).t, 'e2e', 'precondition: it was routing');

  assert.equal(hub.closeExpiredClients(1000), 1);
  const afterSweep = burrowSocket.sent.length;

  // Both shapes: a transport frame inside the old binding, and an `init` that
  // would otherwise bind afresh.
  hub.onClientFrame(client, JSON.stringify(e2eClientFrame(burrowId, { step: 'transport' })));
  hub.onClientFrame(client, JSON.stringify(e2eClientFrame(burrowId)));

  assert.equal(burrowSocket.sent.length, afterSweep, 'a torn-down conn still routed');
});
