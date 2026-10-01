/**
 * The routing cases every Relay passes (`docs/specs/relay.md` -> "Routing"),
 * written once and registered by each Relay's suite: the self-host Relay's
 * `relay/test/relay.test.mjs` and `relay/test/e2e-relay.test.mjs`, and
 * Hosted's `hosted/server/tests/relay-room.test.ts`. One copy, so the two
 * Relays cannot drift into two routings.
 *
 * {@link socketCases} drive bare sockets through a *driver*:
 *
 * - `connectBurrow()` → `{ burrowId, burrowToken, socket }`: a fresh enrolled
 *   Burrow of the account, its socket open.
 * - `reconnectBurrow(burrowToken)` → a second open socket for that Burrow.
 * - `connectClient()` → an open Client socket of the account.
 * - `openClient()` → a Client socket, not awaited.
 *
 * Each socket is `openFrameSocket`'s (`./frame-socket.mjs`).
 *
 * {@link e2eCases} drive the real ceremonies through a fixture shaped like
 * `relay/test/harness/e2e.mjs`'s `e2eFixture`: `{ burrow, client,
 * authenticator, enrollment: { burrowId }, accountId?, replacementBurrow(),
 * secondBurrow(), close() }`.
 */

import assert from 'node:assert/strict';

import {
  MAX_E2E_CIPHERTEXT_LENGTH,
  MAX_RELAY_CLIENT_SOCKETS,
  MAX_RELAY_FRAME_BYTES,
  RELAY_PING,
  RELAY_PONG,
  REMOTE_METHODS,
  WS_CLOSE_BURROW_REPLACED,
  WS_CLOSE_BURROW_REPLACED_REASON,
  WS_CLOSE_FRAME_TOO_LARGE,
  WS_CLOSE_TRY_AGAIN_LATER,
  toBase64Url,
  utf8Encode,
} from '../../dist/index.js';

import { e2eClientFrame, establish, flip, newE2eId, watch } from './envelope.mjs';
import { until } from './frame-socket.mjs';

/** One routing case: a name, and its body against a driver or fixture. */
const relayCase = (name, run) => ({ name, run });

export const socketCases = [
  relayCase(
    'an init round-trips client→burrow with a stamped clientId, and the answer routes back',
    async (relay) => {
      const { burrowId, socket: burrowWs } = await relay.connectBurrow();
      const clientWs = await relay.connectClient();

      const sent = e2eClientFrame(burrowId);
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
      assert.equal(answer.burrowId, burrowId, 'the relay stamps the burrowId from the socket');
      assert.equal(answer.ct, 'YmFy');
      assert.equal(answer.clientId, undefined); // the clientId secret never leaks to the client
    },
  ),

  relayCase('an e2e frame naming an offline burrow returns an error and nothing else', async (relay) => {
    const clientWs = await relay.connectClient();
    clientWs.send(e2eClientFrame(newE2eId()));
    const err = await clientWs.take();
    assert.equal(err.t, 'error');
    assert.match(err.error, /offline/);
    assert.ok(await clientWs.quiet(), 'no further frames for an offline burrow');
  }),

  relayCase('a transport outside a binding reaches no burrow, before and after one exists', async (relay) => {
    // The `init` is what binds; only it may create one. A `transport` that
    // arrives with no binding — or naming a Burrow this socket has bound away
    // from — has nowhere to go, and is dropped rather than answered, so nothing
    // tells a prober which Burrows a session is talking to.
    const a = await relay.connectBurrow();
    const b = await relay.connectBurrow();
    const clientWs = await relay.connectClient();

    // Never bound: the Burrow is online and the frame is well formed anyway.
    clientWs.send(e2eClientFrame(a.burrowId, { step: 'transport' }));
    assert.ok(await a.socket.quiet(), 'an unbound transport reaches no burrow');
    assert.ok(await clientWs.quiet(), 'and is dropped rather than answered');

    // Bound to A, so a transport for B is outside the binding.
    clientWs.send(e2eClientFrame(a.burrowId));
    assert.equal((await a.socket.take()).step, 'init');
    clientWs.send(e2eClientFrame(b.burrowId, { step: 'transport' }));
    assert.ok(await b.socket.quiet(), 'a transport for the unbound burrow is dropped');
    assert.ok(await clientWs.quiet());

    // The binding it does hold still carries.
    clientWs.send(e2eClientFrame(a.burrowId, { step: 'transport' }));
    assert.equal((await a.socket.take()).step, 'transport');
  }),

  relayCase('malformed JSON and unknown client frames get an error; burrow garbage is ignored', async (relay) => {
    const { burrowId, socket: burrowWs } = await relay.connectBurrow();
    const clientWs = await relay.connectClient();

    clientWs.ws.send('this is not json{');
    assert.equal((await clientWs.take()).t, 'error');

    // Every frame the legacy handshake used is now exactly as unknown as any
    // other word: the relay routes the `e2e` envelope and nothing else.
    for (const t of ['pair', 'pair-status', 'connect', 'connect2', 'msg', 'nonsense-type']) {
      clientWs.send({ t, burrowId, data: {}, request: {} });
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

    clientWs.send(e2eClientFrame(burrowId));
    assert.equal((await burrowWs.take()).t, 'e2e');
  }),

  relayCase('a ping is answered with a pong on either socket, and reaches no peer', async (relay) => {
    const { burrowId, socket: burrowWs } = await relay.connectBurrow();
    const clientWs = await relay.connectClient();
    clientWs.send(e2eClientFrame(burrowId));
    await burrowWs.take();

    clientWs.ws.send(RELAY_PING);
    assert.equal(await clientWs.take(), RELAY_PONG);
    burrowWs.ws.send(RELAY_PING);
    assert.equal(await burrowWs.take(), RELAY_PONG);
    // Neither is forwarded, and the Client's draws no `error`.
    assert.ok(await burrowWs.quiet());
    assert.ok(await clientWs.quiet());
  }),

  relayCase('client disconnect delivers client-gone to its burrow', async (relay) => {
    const { burrowId, socket: burrowWs } = await relay.connectBurrow();
    const clientWs = await relay.connectClient();
    clientWs.send(e2eClientFrame(burrowId));
    const forwarded = await burrowWs.take();

    clientWs.close();
    await clientWs.closed;

    const gone = await burrowWs.take();
    assert.deepEqual(gone, { t: 'client-gone', clientId: forwarded.clientId });
  }),

  relayCase('binding to a second burrow tells the first the client is gone', async (relay) => {
    const a = await relay.connectBurrow();
    const b = await relay.connectBurrow();
    const clientWs = await relay.connectClient();

    clientWs.send(e2eClientFrame(a.burrowId));
    const first = await a.socket.take();
    clientWs.send(e2eClientFrame(b.burrowId));
    assert.equal((await b.socket.take()).t, 'e2e');
    assert.deepEqual(await a.socket.take(), { t: 'client-gone', clientId: first.clientId });
  }),

  relayCase('burrow disconnect delivers burrow-gone to all its clients', async (relay) => {
    const { burrowId, socket: burrowWs } = await relay.connectBurrow();
    const clientA = await relay.connectClient();
    const clientB = await relay.connectClient();
    clientA.send(e2eClientFrame(burrowId));
    await burrowWs.take();
    clientB.send(e2eClientFrame(burrowId));
    await burrowWs.take();

    burrowWs.close();
    await burrowWs.closed;

    assert.deepEqual(await clientA.take(), { t: 'burrow-gone' });
    assert.deepEqual(await clientB.take(), { t: 'burrow-gone' });
  }),

  relayCase('a burrow frame for a vanished client is dropped and the Relay keeps routing', async (relay) => {
    const { burrowId, socket: burrowWs } = await relay.connectBurrow();
    const clientWs = await relay.connectClient();
    clientWs.send(e2eClientFrame(burrowId));
    const forwarded = await burrowWs.take();

    clientWs.close();
    await clientWs.closed;
    await burrowWs.take(); // client-gone

    // The counterpart is gone; this must not throw or crash the Relay.
    burrowWs.send({ ...forwarded, step: 'response', burrowId: undefined });

    // Prove the relay is still alive: a fresh client still round-trips.
    const client2 = await relay.connectClient();
    client2.send(e2eClientFrame(burrowId));
    assert.equal((await burrowWs.take()).t, 'e2e');
  }),

  relayCase('a new burrow socket replaces the old one for the same burrowId', async (relay) => {
    const first = await relay.connectBurrow();
    const clientWs = await relay.connectClient();
    clientWs.send(e2eClientFrame(first.burrowId));
    await first.socket.take();
    // Re-open the Burrow socket with the SAME token → same burrowId, displaces the first.
    const second = await relay.reconnectBurrow(first.burrowToken);

    // The displaced socket is closed carrying the code the evicted Burrow keys
    // its stand-down on (lib/src/remote/burrow/burrow-runtime.ts). Pinned here
    // because a changed code would silently restore the reconnect fight.
    const closeEvent = await first.socket.closed;
    assert.equal(closeEvent.code, WS_CLOSE_BURROW_REPLACED);
    assert.equal(closeEvent.reason, WS_CLOSE_BURROW_REPLACED_REASON);
    // Its Client was told, and lost its binding at replacement time.
    assert.deepEqual(await clientWs.take(), { t: 'burrow-gone' });
    clientWs.send(e2eClientFrame(first.burrowId, { step: 'transport' }));
    assert.ok(await second.quiet(), 'the old binding does not carry to the replacement');

    // The new socket serves the same burrowId: a client's frame reaches it.
    const other = await relay.connectClient();
    other.send(e2eClientFrame(first.burrowId));
    assert.equal((await second.take()).t, 'e2e');
  }),

  relayCase('a frame larger than any legal one closes its socket 1009', async (relay) => {
    for (const socket of [await relay.connectClient(), (await relay.connectBurrow()).socket]) {
      socket.ws.send('x'.repeat(MAX_RELAY_FRAME_BYTES + 1));
      assert.equal((await socket.closed).code, WS_CLOSE_FRAME_TOO_LARGE);
    }
  }),

  relayCase('the frame bound counts UTF-8 bytes, not characters', async (relay) => {
    // Two bytes a character: within the bound in characters, past it in bytes.
    const text = 'é'.repeat(Math.floor(MAX_RELAY_FRAME_BYTES / 2) + 1);
    assert.ok(text.length <= MAX_RELAY_FRAME_BYTES);
    for (const socket of [await relay.connectClient(), (await relay.connectBurrow()).socket]) {
      socket.ws.send(text);
      assert.equal((await socket.closed).code, WS_CLOSE_FRAME_TOO_LARGE);
    }
  }),

  relayCase('a maximal legal frame is read, not refused by size', async (relay) => {
    const socket = await relay.connectClient();
    // Well-formed but addressed to no live Burrow, so the answer is the routing
    // error — which is the point: the frame was read rather than rejected by size.
    const frame = e2eClientFrame(newE2eId(), { ct: 'A'.repeat(MAX_E2E_CIPHERTEXT_LENGTH) });
    assert.ok(JSON.stringify(frame).length <= MAX_RELAY_FRAME_BYTES);
    socket.send(frame);
    assert.match((await socket.take(5000)).error, /is offline/);
  }),

  relayCase('client sockets are capped, and the refusal is a retry rather than an eviction', async (relay) => {
    const { burrowId, socket: burrowWs } = await relay.connectBurrow();
    const sockets = [];
    for (let i = 0; i < MAX_RELAY_CLIENT_SOCKETS; i += 1) sockets.push(await relay.connectClient());

    // One past the cap: the upgrade succeeds (the session is valid) and the
    // socket is closed at once with "try again later".
    const refused = relay.openClient();
    assert.equal((await refused.closed).code, WS_CLOSE_TRY_AGAIN_LATER);
    // The sockets already relaying are untouched — dropping one to admit
    // another would let a token holder take the relay away from itself.
    sockets[0].send(e2eClientFrame(burrowId));
    assert.equal((await burrowWs.take()).t, 'e2e');

    // A closed one frees its slot.
    sockets.pop().close();
    await until(async () => {
      const retry = relay.openClient();
      const admitted = await Promise.race([
        retry.ready.then(() => retry.quiet(100)),
        retry.closed.then(() => false),
      ]);
      if (!admitted) return false;
      sockets.push(retry);
      return true;
    }, { timeout: 3000 });
  }),
];

/** Every frame the relay handled: what both peers sent and what it delivered. */
function relayView(...peers) {
  return JSON.stringify(peers.flatMap((peer) => [...peer.sent, ...peer.frames]));
}

export const e2eCases = [
  relayCase('an established session round-trips every transport kind through the relay', async (fixture) => {
    const { burrow, client } = fixture;
    const opens = [];
    burrow.on('e2e-open', (ev) => opens.push(ev));
    await establish(fixture);
    // The connection handshake: both sides agree on the transcript, and IK
    // authenticated the Client's static — the key the ACL conjunction matched.
    const entry = opens.at(-1);
    assert.deepEqual(entry.session.handshakeHash, client.session.handshakeHash);
    assert.equal(entry.clientStaticPublicKey, toBase64Url(fixture.clientStatic.publicKey));

    // Client → Burrow, all three kinds.
    const seen = watch(burrow);
    const payload = utf8Encode('terminal.write rides in here');
    client.sendKeepalive();
    client.sendControl({ presence: 'proof' });
    client.sendApp(payload);
    await until(() => seen.receipts.length === 3);
    assert.equal(seen.receipts[0].receipt.kind, 'keepalive');
    assert.deepEqual(seen.receipts[1].receipt, { kind: 'control', value: { presence: 'proof' } });
    assert.deepEqual(seen.receipts[2].receipt.messages, [payload]);

    // Burrow → Client, on the other direction's cipher state.
    const reply = utf8Encode('terminal.data rides back');
    burrow.e2eSendApp(entry.clientId, reply);
    const frame = await client.nextTransport();
    assert.equal(frame.burrowId, fixture.enrollment.burrowId, 'the relay stamps burrowId');
    assert.deepEqual(client.receiveFrame(frame).messages, [reply]);

    // protocol-v1 inside the same session.
    const hello = await client.remoteRequest({
      requestId: 'r1',
      method: REMOTE_METHODS.hello,
      params: { protocolVersion: 1, viewer: 'phone' },
    });
    assert.equal(hello.ok, true);
    assert.equal(hello.result.burrowId, fixture.enrollment.burrowId);

    // The envelope is the whole surface: an established session opens no other
    // pipe, and every other frame type is simply unknown.
    const burrowFramesBefore = burrow.frames.length;
    client.sendFrame({ t: 'msg', data: { forbidden: true } });
    const refusal = await client.waitFor((f) => f.t === 'error');
    assert.equal(refusal.error, 'unknown frame type');
    assert.equal(burrow.frames.length, burrowFramesBefore, 'nothing else reaches the Burrow');
  }),

  relayCase('teardown: a closed Client socket tells the Burrow client-gone', async (fixture) => {
    const { burrow, client } = fixture;
    const seen = watch(burrow);
    await client.open();
    await until(() => seen.opens.length === 1);
    const { clientId } = seen.opens[0];

    client.close();
    await until(() => burrow.frames.some((f) => f.t === 'client-gone' && f.clientId === clientId));
    assert.equal(burrow.e2eEntry(clientId), undefined, 'the ceremony went with the client');
  }),

  relayCase('teardown: a replaced Burrow is burrow-gone and its late frames are dropped', async (fixture) => {
    const { burrow, client } = fixture;
    const seen = watch(burrow);
    await client.open();
    await until(() => seen.opens.length === 1);
    const entry = seen.opens[0];

    const replacement = await fixture.replacementBurrow();
    const replaced = watch(replacement);
    await client.waitFor((f) => f.t === 'burrow-gone');
    const closed = await burrow.closed;
    assert.equal(closed.code, WS_CLOSE_BURROW_REPLACED);

    // The displaced socket speaks for nobody, so a late transport frame is not forwarded.
    burrow.e2eSendCiphertext(entry, entry.session.sendKeepalive());
    assert.equal(await client.quiet(), true);

    // The replacement is reachable, and its ceremonies are its own: a restarted
    // Burrow has no memory of the session the Client held with its predecessor.
    await client.open();
    await until(() => replaced.opens.length === 1);
    assert.notDeepEqual(replaced.opens[0].session.handshakeHash, entry.session.handshakeHash);
  }),

  relayCase('a Burrow e2e frame for a Client bound elsewhere is not forwarded', async (fixture) => {
    const { burrow, client } = fixture;
    const seen = watch(burrow);
    await client.open();
    await until(() => seen.opens.length === 1);
    const entry = seen.opens[0];

    // The Client rebinds to a different Burrow; the first one is told so.
    const second = await fixture.secondBurrow();
    await client.open({ burrowId: second.burrowId });
    await until(() => burrow.frames.some((f) => f.t === 'client-gone'));

    burrow.e2eSendCiphertext(entry, entry.session.sendKeepalive());
    assert.equal(await client.quiet(), true, 'the old Burrow cannot reach the client');
  }),

  relayCase('the relay is opaque: no plaintext, static, or handshake hash crosses it', async (fixture) => {
    const { burrow, client } = fixture;
    const MARKER = 'DORMOUSE-PLAINTEXT-ORACLE-9f3a';
    const opens = [];
    burrow.on('e2e-open', (ev) => opens.push(ev));
    await establish(fixture);
    const seen = watch(burrow);
    const entry = opens.at(-1);

    client.sendControl({ note: MARKER });
    client.sendApp(utf8Encode(`app ${MARKER}`));
    burrow.e2eSendApp(entry.clientId, utf8Encode(`reply ${MARKER}`));
    await until(() => seen.receipts.length === 2);
    await client.nextTransport();

    const view = relayView(client, burrow);
    assert.equal(view.includes(MARKER), false, 'no plaintext crosses the relay');
    for (const [what, key] of [
      ['burrow static', fixture.burrowStatic.publicKey],
      ['client static', fixture.clientStatic.publicKey],
      ['handshake hash', client.session.handshakeHash],
    ]) {
      assert.equal(view.includes(toBase64Url(key)), false, `${what} must never appear`);
    }
    // What it *does* see is routing only.
    assert.ok(view.includes(fixture.enrollment.burrowId));
  }),

  relayCase('tampering with message 1 is forwarded unexamined and rejected by the Burrow', async (fixture) => {
    const { burrow, client } = fixture;
    const seen = watch(burrow);
    const id = newE2eId();
    await client.open({ id, tamper: (ct) => flip(ct), awaitResponse: false });
    await until(() => seen.errors.length === 1);
    assert.equal(seen.opens.length, 0);
    assert.equal(await client.quiet(), true);
    assert.ok(burrow.frames.some((f) => f.t === 'e2e' && f.id === id && f.step === 'init'));
  }),

  relayCase('the relay refuses malformed e2e frames before they reach the Burrow', async (fixture) => {
    const { burrow, client, enrollment } = fixture;
    const base = {
      t: 'e2e',
      burrowId: enrollment.burrowId,
      kind: 'connection',
      id: newE2eId(),
      step: 'init',
      ct: 'Zm9v',
    };
    const before = burrow.frames.length;
    const bad = [
      { ...base, ct: 'a'.repeat(MAX_E2E_CIPHERTEXT_LENGTH + 1) },
      { ...base, id: 'too-short' },
      { ...base, id: `${newE2eId()}x` },
      { ...base, kind: 'terminal' },
      { ...base, step: 'response' },
      { ...base, step: 'go' },
      { ...base, burrowId: 'not-a-burrow-id' },
      { ...base, ct: '' },
    ];
    for (const frame of bad) {
      client.sendFrame(frame);
      const error = await client.waitFor((f) => f.t === 'error');
      assert.equal(error.error, 'malformed e2e frame', JSON.stringify(frame));
      client.frames.length = 0; // consume, so the next wait sees a fresh one
    }
    assert.equal(burrow.frames.length, before, 'nothing malformed reached the Burrow');

    // A well-formed frame naming a Burrow that is not connected is the ordinary
    // offline refusal, not a malformed one.
    client.sendFrame({ ...base, burrowId: newE2eId() });
    const offline = await client.waitFor((f) => f.t === 'error');
    assert.match(offline.error, /is offline/);
  }),

  relayCase('a transport pipelined behind its init is handled after it, not beside it', async (fixture) => {
    const { burrow, client } = fixture;
    const seen = watch(burrow);
    // Reading message 1 awaits three times before the session is recorded. A
    // Burrow that handled socket frames concurrently would run this transport
    // against a Map that does not hold the ceremony yet.
    const id = newE2eId();
    await client.open({ id, awaitResponse: false });
    client.sendCiphertext(toBase64Url(new Uint8Array(64)), { id });

    await until(() => seen.errors.length === 1);
    assert.equal(seen.opens.length, 1, 'the init completed first');
    assert.match(
      String(seen.errors[0].error),
      /authentication failed/,
      'the ceremony existed by the time its transport was read',
    );
  }),

  relayCase('a transport frame before any init is dropped, not forwarded', async (fixture) => {
    const { burrow, client, enrollment } = fixture;
    // A well-formed transport frame from a Client that has never bound: there
    // is no binding to forward it within, so the relay drops it silently.
    const before = burrow.frames.length;
    client.sendFrame({
      t: 'e2e',
      burrowId: enrollment.burrowId,
      kind: 'connection',
      id: newE2eId(),
      step: 'transport',
      ct: 'Zm9vYmFy',
    });
    assert.equal(await client.quiet(), true, 'not even an error is answered');
    assert.equal(burrow.frames.length, before, 'transport never reaches an unbound Burrow');
  }),

  relayCase('a transport frame outside the binding is dropped, not forwarded', async (fixture) => {
    const { burrow, client } = fixture;
    const seen = watch(burrow);
    await client.open();
    await until(() => seen.opens.length === 1);
    const second = await fixture.secondBurrow();

    // A transport frame naming a Burrow this Client is not bound to.
    const before = second.frames.length;
    client.sendCiphertext(client.session.sendKeepalive(), {});
    client.sendFrame({ ...client.sent.at(-1), burrowId: second.burrowId });
    assert.equal(await client.quiet(), true);
    assert.equal(second.frames.length, before, 'transport never binds a Burrow');
  }),
];
