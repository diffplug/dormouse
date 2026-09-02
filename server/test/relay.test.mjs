/**
 * Relay routing at the socket level (docs/specs/server.md, "Relay"): two real
 * in-process WebSockets echoing through the hub, with no ceremony behind them.
 *
 * The relay routes exactly one envelope, so these cases are about the routing
 * rules rather than about what rides inside: `clientId` stamping and stripping,
 * the refusals, presence teardown (`client-gone` / `host-gone`), and host
 * replacement. The envelope driven by real Noise ceremonies — including its
 * bounds, the binding, and relay opacity — is `e2e-relay.test.mjs`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WS_CLOSE_HOST_REPLACED,
  WS_CLOSE_HOST_REPLACED_REASON,
  WS_ROUTES,
  WS_TOKEN_PARAM,
} from 'server-lib-common';

import { connectClient, connectHost, freshApp, startServer, wsConnect } from './helpers.mjs';
import { e2eClientFrame, newE2eId } from './harness/e2e.mjs';

/** A boot-a-real-server fixture; every test tears its server down in `finally`. */
async function relay() {
  const created = await freshApp();
  const server = await startServer(created);
  return { app: created.app, server, close: () => server.close() };
}

test('an init round-trips client→host with a stamped clientId, and the answer routes back', async () => {
  const { app, server, close } = await relay();
  try {
    const { host, socket: hostWs } = await connectHost(app, server);
    const { socket: clientWs } = await connectClient(app, server);

    const sent = e2eClientFrame(host.hostId);
    clientWs.send(sent);
    const forwarded = await hostWs.take();
    assert.equal(forwarded.t, 'e2e');
    assert.equal(typeof forwarded.clientId, 'string');
    assert.equal(forwarded.id, sent.id);
    assert.equal(forwarded.ct, sent.ct);

    hostWs.send({
      t: 'e2e',
      clientId: forwarded.clientId,
      kind: 'pairing',
      id: sent.id,
      step: 'response',
      ct: 'YmFy',
    });
    const answer = await clientWs.take();
    assert.equal(answer.t, 'e2e');
    assert.equal(answer.hostId, host.hostId, 'the relay stamps the hostId from the socket');
    assert.equal(answer.ct, 'YmFy');
    assert.equal(answer.clientId, undefined); // the clientId secret never leaks to the client
  } finally {
    await close();
  }
});

test('an e2e frame naming an offline host returns an error and nothing else', async () => {
  const { app, server, close } = await relay();
  try {
    const { socket: clientWs } = await connectClient(app, server);
    clientWs.send(e2eClientFrame(newE2eId()));
    const err = await clientWs.take();
    assert.equal(err.t, 'error');
    assert.match(err.error, /offline/);
    assert.ok(await clientWs.quiet(), 'no further frames for an offline host');
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

    // Every frame the legacy handshake used is now exactly as unknown as any
    // other word: the relay routes the `e2e` envelope and nothing else.
    for (const t of ['pair', 'pair-status', 'connect', 'connect2', 'msg', 'nonsense-type']) {
      clientWs.send({ t, hostId: host.hostId, data: {}, request: {} });
      const err = await clientWs.take();
      assert.equal(err.t, 'error');
      assert.equal(err.error, 'unknown frame type', t);
    }
    assert.ok(await hostWs.quiet(), 'the host saw none of them');

    // Garbage from the host is dropped without a reply or a crash — the relay
    // still routes a following valid frame.
    hostWs.ws.send('garbage{');
    hostWs.send({ t: 'unknown-host-frame', clientId: 'whatever' });
    assert.ok(await hostWs.quiet());

    clientWs.send(e2eClientFrame(host.hostId));
    assert.equal((await hostWs.take()).t, 'e2e');
  } finally {
    await close();
  }
});

test('client disconnect delivers client-gone to its host', async () => {
  const { app, server, close } = await relay();
  try {
    const { host, socket: hostWs } = await connectHost(app, server);
    const { socket: clientWs } = await connectClient(app, server);
    clientWs.send(e2eClientFrame(host.hostId));
    const forwarded = await hostWs.take();

    clientWs.close();
    await clientWs.closed;

    const gone = await hostWs.take();
    assert.deepEqual(gone, { t: 'client-gone', clientId: forwarded.clientId });
  } finally {
    await close();
  }
});

test('binding to a second host tells the first the client is gone', async () => {
  const { app, server, close } = await relay();
  try {
    const a = await connectHost(app, server);
    const b = await connectHost(app, server);
    const { socket: clientWs } = await connectClient(app, server);

    clientWs.send(e2eClientFrame(a.host.hostId));
    const first = await a.socket.take();
    clientWs.send(e2eClientFrame(b.host.hostId));
    assert.equal((await b.socket.take()).t, 'e2e');
    assert.deepEqual(await a.socket.take(), { t: 'client-gone', clientId: first.clientId });
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
    clientA.socket.send(e2eClientFrame(host.hostId));
    await hostWs.take();
    clientB.socket.send(e2eClientFrame(host.hostId));
    await hostWs.take();

    hostWs.close();
    await hostWs.closed;

    assert.deepEqual(await clientA.socket.take(), { t: 'host-gone' });
    assert.deepEqual(await clientB.socket.take(), { t: 'host-gone' });
  } finally {
    await close();
  }
});

test('a host frame for a vanished client is dropped and the server keeps routing', async () => {
  const { app, server, close } = await relay();
  try {
    const { host, socket: hostWs } = await connectHost(app, server);
    const { socket: clientWs } = await connectClient(app, server);
    clientWs.send(e2eClientFrame(host.hostId));
    const forwarded = await hostWs.take();

    clientWs.close();
    await clientWs.closed;
    await hostWs.take(); // client-gone

    // The counterpart is gone; this must not throw or crash the process.
    hostWs.send({ ...forwarded, step: 'response', hostId: undefined });

    // Prove the relay is still alive: a fresh client still round-trips.
    const client2 = await connectClient(app, server);
    client2.socket.send(e2eClientFrame(host.hostId));
    assert.equal((await hostWs.take()).t, 'e2e');
  } finally {
    await close();
  }
});

test('a new host socket replaces the old one for the same hostId', async () => {
  const { app, server, close } = await relay();
  try {
    const first = await connectHost(app, server);
    // Re-open /ws/host with the SAME token → same hostId, displaces the first.
    const second = wsConnect(
      `${server.wsUrl}${WS_ROUTES.host}?${WS_TOKEN_PARAM}=${first.host.hostToken}`,
    );
    await second.ready;

    // The displaced socket is closed by the hub, carrying the code the evicted
    // Host keys its stand-down on (lib/src/remote/host/remote-host.ts). Pinned
    // here because a changed code would silently restore the reconnect fight.
    const closeEvent = await first.socket.closed;
    assert.equal(closeEvent.code, WS_CLOSE_HOST_REPLACED);
    assert.equal(closeEvent.reason, WS_CLOSE_HOST_REPLACED_REASON);

    // The new socket serves the same hostId: a client's frame reaches it.
    const { socket: clientWs } = await connectClient(app, server);
    clientWs.send(e2eClientFrame(first.host.hostId));
    assert.equal((await second.take()).t, 'e2e');
    second.close();
  } finally {
    await close();
  }
});
