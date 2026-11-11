/**
 * What bounds a relay socket (docs/specs/relay.md -> "Routing").
 *
 * The frame gates, routing rules, frame-size bound and Client cap are the
 * cases every Relay passes (`relay.test.mjs`); these are the self-host
 * Relay's own: the sweep's two reasons a socket that passed the upgrade is
 * closed afterwards, and a peer that stops reading what it is sent. The
 * upgrade check runs exactly once, which is why the sweep exists at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';

import {
  MAX_E2E_CIPHERTEXT_LENGTH,
  MAX_RELAY_SOCKET_BUFFERED_BYTES,
  WS_CLOSE_TRY_AGAIN_LATER,
  WS_ROUTES,
  WS_TOKEN_PARAM,
} from 'remote-lib-common';

import {
  connectClient,
  connectBurrow,
  freshApp,
  makeClock,
  ownerSession,
  sleep,
  startRelay,
  until,
} from './helpers.mjs';
import { e2eBurrowFrame, e2eClientFrame, newE2eId } from './harness/e2e.mjs';
import { recordingSocket } from './harness/memory-socket.mjs';

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
  // The same code the route's open-time session re-check closes with.
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
  assert.equal(created.hub.onlineBurrowIds().length, 0, 'teardown precedes the close handshake');

  const closed = await socket.closed;
  assert.equal(closed.code, 1001);
});

test('an idle Client releases its slot before the close handshake finishes', async (t) => {
  const clock = makeClock();
  const created = await freshApp({ now: clock.now });
  const server = await startRelay(created);
  t.after(() => server.close());
  const { socket } = await connectClient(created.app, server);
  assert.equal(created.hub.clientCount, 1);

  clock.advance(10 * 60 * 1000);
  assert.equal(created.sweepRelaySockets().idle, 1);
  assert.equal(created.hub.clientCount, 0, 'teardown precedes the close handshake');
  assert.equal((await socket.closed).code, 1001);
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

// --- A peer that stops reading ---------------------------------------------
// Self-host only: a Workers WebSocket reports no buffered byte count, so
// Hosted's RelayRoom cannot run these, and they sit outside the shared
// `relay-parity.mjs` cases (`docs/specs/relay.md` -> "Routing").

/** A Burrow and a Client bound to it, at the hub, each on a recording socket. */
async function boundPair() {
  const { hub } = await freshApp();
  const burrowId = newE2eId();
  const burrowSocket = recordingSocket();
  const burrow = hub.registerBurrow(burrowId, burrowSocket);
  const clientSocket = recordingSocket();
  const client = hub.registerClient(clientSocket, { expiresAt: Number.POSITIVE_INFINITY });
  const init = e2eClientFrame(burrowId);
  hub.onClientFrame(client, JSON.stringify(init));
  const { clientId } = burrowSocket.sent.at(-1);
  const reply = JSON.stringify(e2eBurrowFrame(clientId, { id: init.id }));
  const transport = JSON.stringify(e2eClientFrame(burrowId, { id: init.id, step: 'transport' }));
  return { hub, burrowId, burrow, burrowSocket, client, clientId, clientSocket, reply, transport };
}

test('a Client socket holding the bound is closed instead of sent more', async () => {
  const { hub, burrow, burrowSocket, clientId, clientSocket, reply } = await boundPair();

  // At the bound it is still sent to.
  clientSocket.bufferedAmount = MAX_RELAY_SOCKET_BUFFERED_BYTES;
  hub.onBurrowFrame(burrow, reply);
  assert.equal(clientSocket.sent.length, 1);
  assert.equal(clientSocket.closed, false);

  // Past it, the next frame closes the socket rather than queueing behind it.
  clientSocket.bufferedAmount += 1;
  hub.onBurrowFrame(burrow, reply);
  assert.equal(clientSocket.sent.length, 1, 'a stalled Client was sent more');
  assert.equal(clientSocket.closeCode, WS_CLOSE_TRY_AGAIN_LATER);
  assert.equal(hub.clientCount, 0, 'unregistered, so nothing else routes to it');
  assert.deepEqual(burrowSocket.sent.at(-1), { t: 'client-gone', clientId });
});

test('a Burrow socket holding the bound is closed instead of sent more, and its Clients told', async () => {
  const { hub, burrowId, burrowSocket, client, clientSocket, transport } = await boundPair();
  const forwarded = burrowSocket.sent.length;

  burrowSocket.bufferedAmount = MAX_RELAY_SOCKET_BUFFERED_BYTES + 1;
  hub.onClientFrame(client, transport);
  assert.equal(burrowSocket.sent.length, forwarded, 'a stalled Burrow was sent more');
  assert.equal(burrowSocket.closeCode, WS_CLOSE_TRY_AGAIN_LATER);
  assert.equal(hub.isBurrowOnline(burrowId), false);
  assert.equal(client.burrowId, null);
  assert.equal(clientSocket.sent.at(-1).t, 'burrow-gone');
});

/** A client WebSocket frame: text, masked, short enough for a 16-bit length. */
function maskedText(text) {
  const payload = Buffer.from(text);
  const mask = randomBytes(4);
  const length = payload.length < 126
    ? Buffer.from([0x81, 0x80 | payload.length])
    : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([length, mask, Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]))]);
}

test('a real Client socket that stops reading is closed once the Relay holds the bound for it', async (t) => {
  const created = await freshApp();
  const server = await startRelay(created);
  t.after(() => server.close());
  const { burrow, socket: burrowSocket } = await connectBurrow(created.app, server);
  const { sessionToken } = await ownerSession(created.app);

  // A bare TCP upgrade, so the Client can stop reading its socket as a
  // suspended phone does while the connection stays up.
  const tcp = connect(server.port, '127.0.0.1');
  t.after(() => tcp.destroy());
  tcp.write(
    `GET ${WS_ROUTES.client}?${WS_TOKEN_PARAM}=${sessionToken} HTTP/1.1\r\nhost: 127.0.0.1:${server.port}\r\n`
      + `connection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 13\r\n`
      + `sec-websocket-key: ${randomBytes(16).toString('base64')}\r\n\r\n`,
  );
  const head = await new Promise((resolve) => tcp.once('data', resolve));
  assert.match(head.toString('latin1'), /^HTTP\/1\.1 101/);
  await until(() => created.hub.clientCount === 1);
  const init = e2eClientFrame(burrow.burrowId);
  tcp.write(maskedText(JSON.stringify(init)));
  const { clientId } = await burrowSocket.take();
  tcp.pause();

  // Maximal transport frames, capped at eight times the bound; the kernel's
  // own socket buffers take a little before the Relay's starts to fill.
  const frame = JSON.stringify(e2eBurrowFrame(clientId, {
    id: init.id, step: 'transport', ct: 'A'.repeat(MAX_E2E_CIPHERTEXT_LENGTH - 8),
  }));
  const cap = 8 * MAX_RELAY_SOCKET_BUFFERED_BYTES;
  let sent = 0;
  while (created.hub.clientCount > 0 && sent < cap) {
    for (let i = 0; i < 4; i += 1) burrowSocket.ws.send(frame);
    sent += 4 * frame.length;
    await sleep(2);
  }
  assert.equal(created.hub.clientCount, 0, `still routing to a Client that read nothing of ${sent} bytes`);
  const gone = await burrowSocket.take();
  assert.deepEqual(gone, { t: 'client-gone', clientId });
});
