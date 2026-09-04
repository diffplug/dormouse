import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RelayHub } from '../dist/relay.js';
import { e2eClientFrame, e2eHostFrame, newE2eId } from './harness/e2e.mjs';
import { recordingSocket } from './harness/memory-socket.mjs';

/** A session that never expires: these cases are about sockets, not TTLs. */
const LIVE_SESSION = { expiresAt: Number.POSITIVE_INFINITY };

/**
 * Unit tests for the displaced-host-socket guard, driving RelayHub directly
 * with fake sockets: a socket replaced by a host reconnect may still deliver
 * queued frames, and those must never reach a Client the replacement never
 * handshook with.
 */

const HOST_A = newE2eId();
const HOST_B = newE2eId();

// `RelayHub` is driven with raw strings here, one level below the socket.
const clientFrame = (hostId, overrides) => JSON.stringify(e2eClientFrame(hostId, overrides));
const hostFrame = (clientId, overrides) => JSON.stringify(e2eHostFrame(clientId, overrides));

/** Register a client and bind it to `hostId`. */
function boundClient(hub, hostId) {
  const socket = recordingSocket();
  const client = hub.registerClient(socket, LIVE_SESSION);
  hub.onClientFrame(client, clientFrame(hostId));
  assert.equal(client.hostId, hostId, 'precondition: bound');
  return { socket, client };
}

test('frames from a displaced host socket are ignored', () => {
  const hub = new RelayHub();
  const oldSocket = recordingSocket();
  const oldConn = hub.registerHost(HOST_A, oldSocket);
  const { socket: clientSocket, client } = boundClient(hub, HOST_A);

  // The host reconnects: the old socket is displaced and the binding dropped.
  const newSocket = recordingSocket();
  const newConn = hub.registerHost(HOST_A, newSocket);
  assert.equal(oldSocket.closed, true);
  assert.equal(client.hostId, null);
  assert.ok(clientSocket.sent.some((f) => f.t === 'host-gone'));

  const sentBefore = clientSocket.sent.length;
  hub.onHostFrame(oldConn, hostFrame(client.clientId));
  assert.equal(clientSocket.sent.length, sentBefore, 'no frames routed from the displaced socket');

  // The replacement socket still works end to end.
  hub.onClientFrame(client, clientFrame(HOST_A));
  assert.ok(newSocket.sent.some((f) => f.t === 'e2e'));
  hub.onHostFrame(newConn, hostFrame(client.clientId, { ct: 'bGl2ZQ' }));
  assert.ok(clientSocket.sent.some((f) => f.t === 'e2e' && f.ct === 'bGl2ZQ'));
});

test('a displaced socket is also ignored after the replacement disconnects', () => {
  const hub = new RelayHub();
  const oldConn = hub.registerHost(HOST_A, recordingSocket());
  const { socket: clientSocket, client } = boundClient(hub, HOST_A);

  const newConn = hub.registerHost(HOST_A, recordingSocket());
  hub.unregisterHost(newConn); // host fully offline now
  const sentBefore = clientSocket.sent.length;

  hub.onHostFrame(oldConn, hostFrame(client.clientId));
  assert.equal(
    clientSocket.sent.length,
    sentBefore,
    'stale socket cannot speak for an offline host',
  );
});

test('late frames from a host the client left are ignored', () => {
  const hub = new RelayHub();
  const hostA = hub.registerHost(HOST_A, recordingSocket());
  hub.registerHost(HOST_B, recordingSocket());
  const clientSocket = recordingSocket();
  const client = hub.registerClient(clientSocket, LIVE_SESSION);

  hub.onClientFrame(client, clientFrame(HOST_A));
  hub.onClientFrame(client, clientFrame(HOST_B));
  assert.equal(client.hostId, HOST_B);

  hub.onHostFrame(hostA, hostFrame(client.clientId));
  assert.deepEqual(clientSocket.sent, [], 'stale host frames must not reach the client');
  assert.equal(client.hostId, HOST_B);
});

test('rebinding a client tells the previous host client-gone', () => {
  const hub = new RelayHub();
  const hostA = hub.registerHost(HOST_A, recordingSocket());
  const hostB = hub.registerHost(HOST_B, recordingSocket());
  const { client } = boundClient(hub, HOST_A);

  hub.onClientFrame(client, clientFrame(HOST_B));

  assert.deepEqual(hostA.socket.sent.at(-1), { t: 'client-gone', clientId: client.clientId });
  assert.equal(hostB.socket.sent.at(-1)?.t, 'e2e');
  assert.equal(hostB.socket.sent.at(-1)?.clientId, client.clientId);
  assert.equal(client.hostId, HOST_B);
});
