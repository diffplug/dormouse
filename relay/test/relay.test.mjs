/**
 * Relay routing at the socket level (docs/specs/relay.md, "Relay"): two real
 * in-process WebSockets echoing through the hub, with no ceremony behind them.
 *
 * The relay routes exactly one envelope, so these cases are about the routing
 * rules rather than about what rides inside: `clientId` stamping and stripping,
 * the refusals, presence teardown (`client-gone` / `burrow-gone`), and burrow
 * replacement. The envelope driven by real Noise ceremonies — including its
 * bounds, the binding, and relay opacity — is `e2e-relay.test.mjs`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WS_CLOSE_BURROW_REPLACED,
  WS_CLOSE_BURROW_REPLACED_REASON,
  WS_ROUTES,
  WS_TOKEN_PARAM,
} from 'remote-lib-common';

import { connectClient, connectBurrow, freshApp, startRelay, wsConnect } from './helpers.mjs';
import { e2eClientFrame, newE2eId } from './harness/e2e.mjs';

/** A boot-a-real-server fixture; every test tears its Relay down in `finally`. */
async function relay() {
  const created = await freshApp();
  const server = await startRelay(created);
  return { app: created.app, server, close: () => server.close() };
}

test('an init round-trips client→burrow with a stamped clientId, and the answer routes back', async () => {
  const { app, server, close } = await relay();
  try {
    const { burrow, socket: burrowWs } = await connectBurrow(app, server);
    const { socket: clientWs } = await connectClient(app, server);

    const sent = e2eClientFrame(burrow.burrowId);
    clientWs.send(sent);
    const forwarded = await burrowWs.take();
    assert.equal(forwarded.t, 'e2e');
    assert.equal(typeof forwarded.clientId, 'string');
    assert.equal(forwarded.id, sent.id);
    assert.equal(forwarded.ct, sent.ct);

    burrowWs.send({
      t: 'e2e',
      clientId: forwarded.clientId,
      kind: 'pairing',
      id: sent.id,
      step: 'response',
      ct: 'YmFy',
    });
    const answer = await clientWs.take();
    assert.equal(answer.t, 'e2e');
    assert.equal(answer.burrowId, burrow.burrowId, 'the relay stamps the burrowId from the socket');
    assert.equal(answer.ct, 'YmFy');
    assert.equal(answer.clientId, undefined); // the clientId secret never leaks to the client
  } finally {
    await close();
  }
});

test('an e2e frame naming an offline burrow returns an error and nothing else', async () => {
  const { app, server, close } = await relay();
  try {
    const { socket: clientWs } = await connectClient(app, server);
    clientWs.send(e2eClientFrame(newE2eId()));
    const err = await clientWs.take();
    assert.equal(err.t, 'error');
    assert.match(err.error, /offline/);
    assert.ok(await clientWs.quiet(), 'no further frames for an offline burrow');
  } finally {
    await close();
  }
});

test('a transport outside a binding reaches no burrow, before and after one exists', async () => {
  // The `init` is what binds; only it may create one. A `transport` that
  // arrives with no binding — or naming a Burrow this socket has bound away
  // from — has nowhere to go, and is dropped rather than answered, so nothing
  // tells a prober which Burrows a session is talking to.
  const { app, server, close } = await relay();
  try {
    const a = await connectBurrow(app, server);
    const b = await connectBurrow(app, server);
    const { socket: clientWs } = await connectClient(app, server);

    // Never bound: the Burrow is online and the frame is well formed anyway.
    clientWs.send(e2eClientFrame(a.burrow.burrowId, { step: 'transport' }));
    assert.ok(await a.socket.quiet(), 'an unbound transport reaches no burrow');
    assert.ok(await clientWs.quiet(), 'and is dropped rather than answered');

    // Bound to A, so a transport for B is outside the binding.
    clientWs.send(e2eClientFrame(a.burrow.burrowId));
    assert.equal((await a.socket.take()).step, 'init');
    clientWs.send(e2eClientFrame(b.burrow.burrowId, { step: 'transport' }));
    assert.ok(await b.socket.quiet(), 'a transport for the unbound burrow is dropped');
    assert.ok(await clientWs.quiet());

    // The binding it does hold still carries.
    clientWs.send(e2eClientFrame(a.burrow.burrowId, { step: 'transport' }));
    assert.equal((await a.socket.take()).step, 'transport');
  } finally {
    await close();
  }
});

test('malformed JSON and unknown client frames get an error; burrow garbage is ignored', async () => {
  const { app, server, close } = await relay();
  try {
    const { burrow, socket: burrowWs } = await connectBurrow(app, server);
    const { socket: clientWs } = await connectClient(app, server);

    clientWs.ws.send('this is not json{');
    assert.equal((await clientWs.take()).t, 'error');

    // Every frame the legacy handshake used is now exactly as unknown as any
    // other word: the relay routes the `e2e` envelope and nothing else.
    for (const t of ['pair', 'pair-status', 'connect', 'connect2', 'msg', 'nonsense-type']) {
      clientWs.send({ t, burrowId: burrow.burrowId, data: {}, request: {} });
      const err = await clientWs.take();
      assert.equal(err.t, 'error');
      assert.equal(err.error, 'unknown frame type', t);
    }
    assert.ok(await burrowWs.quiet(), 'the burrow saw none of them');

    // Garbage from the burrow is dropped without a reply or a crash — the relay
    // still routes a following valid frame.
    burrowWs.ws.send('garbage{');
    burrowWs.send({ t: 'unknown-burrow-frame', clientId: 'whatever' });
    assert.ok(await burrowWs.quiet());

    clientWs.send(e2eClientFrame(burrow.burrowId));
    assert.equal((await burrowWs.take()).t, 'e2e');
  } finally {
    await close();
  }
});

test('client disconnect delivers client-gone to its burrow', async () => {
  const { app, server, close } = await relay();
  try {
    const { burrow, socket: burrowWs } = await connectBurrow(app, server);
    const { socket: clientWs } = await connectClient(app, server);
    clientWs.send(e2eClientFrame(burrow.burrowId));
    const forwarded = await burrowWs.take();

    clientWs.close();
    await clientWs.closed;

    const gone = await burrowWs.take();
    assert.deepEqual(gone, { t: 'client-gone', clientId: forwarded.clientId });
  } finally {
    await close();
  }
});

test('binding to a second burrow tells the first the client is gone', async () => {
  const { app, server, close } = await relay();
  try {
    const a = await connectBurrow(app, server);
    const b = await connectBurrow(app, server);
    const { socket: clientWs } = await connectClient(app, server);

    clientWs.send(e2eClientFrame(a.burrow.burrowId));
    const first = await a.socket.take();
    clientWs.send(e2eClientFrame(b.burrow.burrowId));
    assert.equal((await b.socket.take()).t, 'e2e');
    assert.deepEqual(await a.socket.take(), { t: 'client-gone', clientId: first.clientId });
  } finally {
    await close();
  }
});

test('burrow disconnect delivers burrow-gone to all its clients', async () => {
  const { app, server, close } = await relay();
  try {
    const { burrow, socket: burrowWs } = await connectBurrow(app, server);
    const clientA = await connectClient(app, server);
    const clientB = await connectClient(app, server);
    clientA.socket.send(e2eClientFrame(burrow.burrowId));
    await burrowWs.take();
    clientB.socket.send(e2eClientFrame(burrow.burrowId));
    await burrowWs.take();

    burrowWs.close();
    await burrowWs.closed;

    assert.deepEqual(await clientA.socket.take(), { t: 'burrow-gone' });
    assert.deepEqual(await clientB.socket.take(), { t: 'burrow-gone' });
  } finally {
    await close();
  }
});

test('a burrow frame for a vanished client is dropped and the Relay keeps routing', async () => {
  const { app, server, close } = await relay();
  try {
    const { burrow, socket: burrowWs } = await connectBurrow(app, server);
    const { socket: clientWs } = await connectClient(app, server);
    clientWs.send(e2eClientFrame(burrow.burrowId));
    const forwarded = await burrowWs.take();

    clientWs.close();
    await clientWs.closed;
    await burrowWs.take(); // client-gone

    // The counterpart is gone; this must not throw or crash the process.
    burrowWs.send({ ...forwarded, step: 'response', burrowId: undefined });

    // Prove the relay is still alive: a fresh client still round-trips.
    const client2 = await connectClient(app, server);
    client2.socket.send(e2eClientFrame(burrow.burrowId));
    assert.equal((await burrowWs.take()).t, 'e2e');
  } finally {
    await close();
  }
});

test('a new burrow socket replaces the old one for the same burrowId', async () => {
  const { app, server, close } = await relay();
  try {
    const first = await connectBurrow(app, server);
    // Re-open /ws/burrow with the SAME token → same burrowId, displaces the first.
    const second = wsConnect(
      `${server.wsUrl}${WS_ROUTES.burrow}?${WS_TOKEN_PARAM}=${first.burrow.burrowToken}`,
    );
    await second.ready;

    // The displaced socket is closed by the hub, carrying the code the evicted
    // Burrow keys its stand-down on (lib/src/remote/burrow/burrow-runtime.ts). Pinned
    // here because a changed code would silently restore the reconnect fight.
    const closeEvent = await first.socket.closed;
    assert.equal(closeEvent.code, WS_CLOSE_BURROW_REPLACED);
    assert.equal(closeEvent.reason, WS_CLOSE_BURROW_REPLACED_REASON);

    // The new socket serves the same burrowId: a client's frame reaches it.
    const { socket: clientWs } = await connectClient(app, server);
    clientWs.send(e2eClientFrame(first.burrow.burrowId));
    assert.equal((await second.take()).t, 'e2e');
    second.close();
  } finally {
    await close();
  }
});
