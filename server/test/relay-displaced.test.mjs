import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RelayHub } from '../dist/relay.js';

/**
 * Unit tests for the displaced-host-socket guard, driving RelayHub directly
 * with fake sockets: a socket replaced by a host reconnect may still deliver
 * queued frames, and those must never re-establish or feed sessions the
 * replacement invalidated.
 */

/** A HandshakeGate that approves everything — routing is what's under test. */
const openGate = {
  observeChallenge() {},
  forgetClient() {},
  checkPair: async () => ({ ok: true }),
  checkConnect2: async () => ({ ok: true }),
};

function fakeSocket() {
  return {
    sent: [],
    closed: false,
    send(data) {
      this.sent.push(JSON.parse(data));
    },
    close() {
      this.closed = true;
    },
  };
}

/** Register a client, bind it to `hostId`, and establish via a host decision. */
async function establishedClient(hub, hostConn, hostId) {
  const socket = fakeSocket();
  const client = hub.registerClient(socket);
  await hub.onClientFrame(client, JSON.stringify({ t: 'connect', hostId }));
  hub.onHostFrame(hostConn, JSON.stringify({ t: 'decision', clientId: client.clientId, allowed: true }));
  assert.equal(client.established, true, 'precondition: session established');
  return { socket, client };
}

test('frames from a displaced host socket are ignored', async () => {
  const hub = new RelayHub(openGate);
  const oldSocket = fakeSocket();
  const oldConn = hub.registerHost('h1', oldSocket);
  const { socket: clientSocket, client } = await establishedClient(hub, oldConn, 'h1');

  // The host reconnects: the old socket is displaced and the session dropped.
  const newSocket = fakeSocket();
  const newConn = hub.registerHost('h1', newSocket);
  assert.equal(oldSocket.closed, true);
  assert.equal(client.established, false);
  assert.ok(clientSocket.sent.some((f) => f.t === 'host-gone'));

  const sentBefore = clientSocket.sent.length;

  // A late decision from the displaced socket must not resurrect the session.
  hub.onHostFrame(
    oldConn,
    JSON.stringify({ t: 'decision', clientId: client.clientId, allowed: true }),
  );
  assert.equal(client.established, false, 'displaced decision must not establish');

  // Late msg/challenge/pair-result from the displaced socket must not reach the client.
  hub.onHostFrame(
    oldConn,
    JSON.stringify({ t: 'msg', clientId: client.clientId, data: { stale: true } }),
  );
  hub.onHostFrame(
    oldConn,
    JSON.stringify({ t: 'challenge', clientId: client.clientId, challenge: 'x', expiresAt: 9e15 }),
  );
  hub.onHostFrame(
    oldConn,
    JSON.stringify({ t: 'pair-result', clientId: client.clientId, approved: true }),
  );
  assert.equal(clientSocket.sent.length, sentBefore, 'no frames routed from the displaced socket');

  // The replacement socket still works end to end.
  await hub.onClientFrame(client, JSON.stringify({ t: 'connect', hostId: 'h1' }));
  assert.ok(newSocket.sent.some((f) => f.t === 'connect'));
  hub.onHostFrame(
    newConn,
    JSON.stringify({ t: 'decision', clientId: client.clientId, allowed: true }),
  );
  assert.equal(client.established, true);
  hub.onHostFrame(
    newConn,
    JSON.stringify({ t: 'msg', clientId: client.clientId, data: { live: true } }),
  );
  assert.ok(clientSocket.sent.some((f) => f.t === 'msg' && f.data?.live === true));
});

test('a displaced socket is also ignored after the replacement disconnects', async () => {
  const hub = new RelayHub(openGate);
  const oldConn = hub.registerHost('h1', fakeSocket());
  const { client } = await establishedClient(hub, oldConn, 'h1');

  const newConn = hub.registerHost('h1', fakeSocket());
  hub.unregisterHost(newConn); // host fully offline now

  hub.onHostFrame(
    oldConn,
    JSON.stringify({ t: 'decision', clientId: client.clientId, allowed: true }),
  );
  assert.equal(client.established, false, 'stale socket cannot speak for an offline host');
});

test('late replies from a host the client left are ignored', async () => {
  const hub = new RelayHub(openGate);
  const hostA = hub.registerHost('h1', fakeSocket());
  const hostB = hub.registerHost('h2', fakeSocket());
  const clientSocket = fakeSocket();
  const client = hub.registerClient(clientSocket);

  await hub.onClientFrame(client, JSON.stringify({ t: 'connect', hostId: 'h1' }));
  assert.equal(hostA.socket.sent.at(-1)?.t, 'connect');
  await hub.onClientFrame(client, JSON.stringify({ t: 'connect', hostId: 'h2' }));
  assert.equal(client.hostId, 'h2');
  assert.equal(hostB.socket.sent.at(-1)?.t, 'connect');

  hub.onHostFrame(
    hostA,
    JSON.stringify({ t: 'challenge', clientId: client.clientId, challenge: 'stale', expiresAt: 9e15 }),
  );
  hub.onHostFrame(
    hostA,
    JSON.stringify({ t: 'pair-result', clientId: client.clientId, approved: true }),
  );
  hub.onHostFrame(
    hostA,
    JSON.stringify({ t: 'decision', clientId: client.clientId, allowed: true }),
  );

  assert.deepEqual(clientSocket.sent, [], 'stale host replies must not reach the client');
  assert.equal(client.hostId, 'h2');
  assert.equal(client.established, false, 'stale host decision must not establish');
});

test('rebinding a client tells the previous host client-gone', async () => {
  const hub = new RelayHub(openGate);
  const hostA = hub.registerHost('h1', fakeSocket());
  const hostB = hub.registerHost('h2', fakeSocket());
  const { client } = await establishedClient(hub, hostA, 'h1');

  await hub.onClientFrame(client, JSON.stringify({ t: 'connect', hostId: 'h2' }));

  assert.deepEqual(hostA.socket.sent.at(-1), { t: 'client-gone', clientId: client.clientId });
  assert.equal(hostB.socket.sent.at(-1)?.t, 'connect');
  assert.equal(hostB.socket.sent.at(-1)?.clientId, client.clientId);
  assert.equal(client.hostId, 'h2');
  assert.equal(client.established, false);
});
