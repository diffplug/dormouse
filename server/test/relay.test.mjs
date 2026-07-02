/**
 * Slice-2 relay routing (docs/specs/server.md, "Relay"): two real in-process
 * WebSockets echoing through the hub. Covers the handshake allowlist (`pair` /
 * `connect` / `connect2` up, `pair-result` / `challenge` / `decision` down), the
 * `msg` gate that only opens on an allowed Host decision, presence teardown
 * (`client-gone` / `host-gone`), and the malformed/unknown-frame paths.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WS_ROUTES, WS_TOKEN_PARAM } from 'server-lib-common';

import { connectClient, connectHost, freshApp, startServer, wsConnect } from './helpers.mjs';

/** A boot-a-real-server fixture; every test tears its server down in `finally`. */
async function relay() {
  const created = await freshApp();
  const server = await startServer(created);
  return { app: created.app, server, close: () => server.close() };
}

const PAIRING_REQUEST = {
  accountId: 'owner',
  passkeyCredentialId: 'cred-1',
  passkeyPublicKeyHash: 'hash-1',
  devicePublicKey: 'device-1',
  requestedLabel: 'iPhone Safari',
};

test('pair round-trips client→host with a stamped clientId, pair-result routes back', async () => {
  const { app, server, close } = await relay();
  try {
    const { host, socket: hostWs } = await connectHost(app, server);
    const { socket: clientWs } = await connectClient(app, server);

    clientWs.send({ t: 'pair', hostId: host.hostId, request: PAIRING_REQUEST });
    const forwarded = await hostWs.take();
    assert.equal(forwarded.t, 'pair');
    assert.equal(typeof forwarded.clientId, 'string');
    assert.deepEqual(forwarded.request, PAIRING_REQUEST);

    const record = { hostId: host.hostId, accountId: 'owner' };
    hostWs.send({ t: 'pair-result', clientId: forwarded.clientId, approved: true, record });
    const result = await clientWs.take();
    assert.equal(result.t, 'pair-result');
    assert.equal(result.approved, true);
    assert.deepEqual(result.record, record);
    assert.equal(result.clientId, undefined); // the clientId secret never leaks to the client
  } finally {
    await close();
  }
});

test('connect round-trips and challenge routes back with the originating hostId', async () => {
  const { app, server, close } = await relay();
  try {
    const { host, socket: hostWs } = await connectHost(app, server);
    const { socket: clientWs } = await connectClient(app, server);

    clientWs.send({ t: 'connect', hostId: host.hostId });
    const connFrame = await hostWs.take();
    assert.equal(connFrame.t, 'connect');
    assert.equal(typeof connFrame.clientId, 'string');

    hostWs.send({ t: 'challenge', clientId: connFrame.clientId, challenge: 'chal-abc', expiresAt: 999 });
    const challenge = await clientWs.take();
    assert.deepEqual(challenge, {
      t: 'challenge',
      hostId: host.hostId,
      challenge: 'chal-abc',
      expiresAt: 999,
    });
  } finally {
    await close();
  }
});

test('msg is blocked until an allowed decision, then flows both ways', async () => {
  const { app, server, close } = await relay();
  try {
    const { host, socket: hostWs } = await connectHost(app, server);
    const { socket: clientWs } = await connectClient(app, server);

    clientWs.send({ t: 'connect', hostId: host.hostId });
    const connFrame = await hostWs.take();
    const clientId = connFrame.clientId;

    // Blocked before the decision.
    clientWs.send({ t: 'msg', data: { attempted: true } });
    assert.ok(await hostWs.quiet(), 'host must not receive msg before the decision');

    // The Host's allowed decision establishes the session.
    hostWs.send({ t: 'decision', clientId, allowed: true });
    const decision = await clientWs.take();
    assert.deepEqual(decision, { t: 'decision', allowed: true });

    // Client → host.
    clientWs.send({ t: 'msg', data: { up: 1 } });
    const up = await hostWs.take();
    assert.equal(up.t, 'msg');
    assert.equal(up.clientId, clientId);
    assert.deepEqual(up.data, { up: 1 });

    // Host → client (clientId stripped).
    hostWs.send({ t: 'msg', clientId, data: { down: 2 } });
    const down = await clientWs.take();
    assert.equal(down.t, 'msg');
    assert.deepEqual(down.data, { down: 2 });
    assert.equal(down.clientId, undefined);
  } finally {
    await close();
  }
});

test('msg stays blocked for a second, un-established client', async () => {
  const { app, server, close } = await relay();
  try {
    const { host, socket: hostWs } = await connectHost(app, server);
    const { socket: clientWs } = await connectClient(app, server);
    clientWs.send({ t: 'connect', hostId: host.hostId });
    const first = await hostWs.take();
    hostWs.send({ t: 'decision', clientId: first.clientId, allowed: true });
    await clientWs.take();

    // A second client connects but is never approved.
    const { socket: client2Ws } = await connectClient(app, server);
    client2Ws.send({ t: 'connect', hostId: host.hostId });
    const second = await hostWs.take();

    hostWs.send({ t: 'msg', clientId: second.clientId, data: { x: 1 } });
    assert.ok(await client2Ws.quiet(), 'un-established client must not receive host msg');
    client2Ws.send({ t: 'msg', data: { y: 1 } });
    assert.ok(await hostWs.quiet(), 'un-established client msg must not reach the host');
  } finally {
    await close();
  }
});

test('connect to an unknown/offline host returns an error and nothing else', async () => {
  const { app, server, close } = await relay();
  try {
    const { socket: clientWs } = await connectClient(app, server);
    clientWs.send({ t: 'connect', hostId: 'no-such-host' });
    const err = await clientWs.take();
    assert.equal(err.t, 'error');
    assert.match(err.error, /offline/);
    assert.ok(await clientWs.quiet(), 'no further frames for an offline connect');
  } finally {
    await close();
  }
});

test('malformed JSON and unknown client frames get an error; host garbage is ignored', async () => {
  const { app, server, close } = await relay();
  try {
    const { host, socket: hostWs } = await connectHost(app, server);
    const { socket: clientWs } = await connectClient(app, server);

    clientWs.ws.send('this is not json{');
    assert.equal((await clientWs.take()).t, 'error');

    clientWs.send({ t: 'nonsense-type' });
    assert.equal((await clientWs.take()).t, 'error');

    // Garbage from the host is dropped without a reply or a crash — the relay
    // still routes a following valid frame.
    hostWs.ws.send('garbage{');
    hostWs.send({ t: 'unknown-host-frame', clientId: 'whatever' });
    assert.ok(await hostWs.quiet());

    clientWs.send({ t: 'connect', hostId: host.hostId });
    assert.equal((await hostWs.take()).t, 'connect');
  } finally {
    await close();
  }
});

test('client disconnect delivers client-gone to its host', async () => {
  const { app, server, close } = await relay();
  try {
    const { host, socket: hostWs } = await connectHost(app, server);
    const { socket: clientWs } = await connectClient(app, server);
    clientWs.send({ t: 'connect', hostId: host.hostId });
    const connFrame = await hostWs.take();

    clientWs.close();
    await clientWs.closed;

    const gone = await hostWs.take();
    assert.deepEqual(gone, { t: 'client-gone', clientId: connFrame.clientId });
  } finally {
    await close();
  }
});

test('host disconnect delivers host-gone to all its clients', async () => {
  const { app, server, close } = await relay();
  try {
    const { host, socket: hostWs } = await connectHost(app, server);
    const clientA = await connectClient(app, server);
    const clientB = await connectClient(app, server);
    clientA.socket.send({ t: 'connect', hostId: host.hostId });
    await hostWs.take();
    clientB.socket.send({ t: 'connect', hostId: host.hostId });
    await hostWs.take();

    hostWs.close();
    await hostWs.closed;

    assert.deepEqual(await clientA.socket.take(), { t: 'host-gone' });
    assert.deepEqual(await clientB.socket.take(), { t: 'host-gone' });
  } finally {
    await close();
  }
});

test('a msg to a vanished client is dropped and the server keeps routing', async () => {
  const { app, server, close } = await relay();
  try {
    const { host, socket: hostWs } = await connectHost(app, server);
    const { socket: clientWs } = await connectClient(app, server);
    clientWs.send({ t: 'connect', hostId: host.hostId });
    const connFrame = await hostWs.take();
    hostWs.send({ t: 'decision', clientId: connFrame.clientId, allowed: true });
    await clientWs.take();

    clientWs.close();
    await clientWs.closed;
    await hostWs.take(); // client-gone

    // The counterpart is gone; this must not throw or crash the process.
    hostWs.send({ t: 'msg', clientId: connFrame.clientId, data: { orphan: true } });

    // Prove the relay is still alive: a fresh client still round-trips.
    const client2 = await connectClient(app, server);
    client2.socket.send({ t: 'connect', hostId: host.hostId });
    assert.equal((await hostWs.take()).t, 'connect');
  } finally {
    await close();
  }
});

test('a new host socket replaces the old one for the same hostId', async () => {
  const { app, server, close } = await relay();
  try {
    const first = await connectHost(app, server, { label: 'Laptop' });
    // Re-open /ws/host with the SAME token → same hostId, displaces the first.
    const second = wsConnect(
      `${server.wsUrl}${WS_ROUTES.host}?${WS_TOKEN_PARAM}=${first.host.hostToken}`,
    );
    await second.ready;

    // The displaced socket is closed by the hub.
    await first.socket.closed;

    // The new socket serves the same hostId: a client connect reaches it.
    const { socket: clientWs } = await connectClient(app, server);
    clientWs.send({ t: 'connect', hostId: first.host.hostId });
    assert.equal((await second.take()).t, 'connect');
    second.close();
  } finally {
    await close();
  }
});
