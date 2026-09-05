/**
 * The `e2e` relay envelope driven end to end through the real Relay
 * (docs/specs/relay.md -> "Routing"): one Noise IK ceremony between a fake Client
 * and a fake Burrow, with both statics injected by the test.
 *
 * What it proves, in the order the scope asks for it
 * (docs/specs/remote-security-model.md -> `## Future` -> **Scope:
 * e2e-client-burrow**, stage 3): prologue and transcript binding, directional
 * cipher states, counters, framing, teardown, relay opacity, tamper rejection,
 * and the relay's own bounds. The framing in isolation is
 * `remote-lib-common/test/noise-transport.test.mjs`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_E2E_CIPHERTEXT_LENGTH,
  WS_CLOSE_BURROW_REPLACED,
  e2eConnectionPrologue,
  fromBase64Url,
  generateNoiseKeyPair,
  toBase64Url,
  utf8Encode,
} from 'remote-lib-common';

import { until } from './helpers.mjs';
import { e2eFixture, establish, flip, newE2eId, watch } from './harness/e2e.mjs';

const EMPTY = new Uint8Array(0);

/** Every frame the relay handled: what both peers sent and what it delivered. */
function relayView(...peers) {
  return JSON.stringify(peers.flatMap((peer) => [...peer.sent, ...peer.frames]));
}

test('an established session round-trips every transport kind through the relay', async () => {
  const fixture = await e2eFixture();
  const { burrow, client, clientStatic } = fixture;
  const opens = [];
  burrow.on('e2e-open', (ev) => opens.push(ev));
  try {
    await establish(fixture);
    // The connection handshake: both sides agree on the transcript, and IK
    // authenticated the Client's static — the key the ACL conjunction matched.
    const entry = opens.at(-1);
    assert.deepEqual(entry.session.handshakeHash, client.session.handshakeHash);
    assert.equal(entry.clientStaticPublicKey, toBase64Url(clientStatic.publicKey));

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

    // The envelope is the whole surface: an established session opens no other
    // pipe, and every other frame type is simply unknown.
    const burrowFramesBefore = burrow.frames.length;
    client.sendFrame({ t: 'msg', data: { forbidden: true } });
    const refusal = await client.waitFor((f) => f.t === 'error');
    assert.equal(refusal.error, 'unknown frame type');
    assert.equal(burrow.frames.length, burrowFramesBefore, 'nothing else reaches the Burrow');
  } finally {
    await fixture.close();
  }
});

test('the transcript binds: a wrong prologue fails message 1', async () => {
  const fixture = await e2eFixture();
  const { burrow, client } = fixture;
  const seen = watch(burrow);
  try {
    const id = newE2eId();
    await client.open({
      id,
      // The same ceremony, a different connection id in the prologue only.
      prologue: e2eConnectionPrologue(fixture.enrollment.burrowId, newE2eId()),
      awaitResponse: false,
    });
    await until(() => seen.errors.length === 1);
    assert.equal(seen.opens.length, 0, 'no session was established');
    assert.equal(await client.quiet(), true, 'the Burrow answered nothing');
    // The relay forwarded it all the same: it cannot tell a bound transcript
    // from an unbound one, which is the point.
    assert.ok(burrow.frames.some((f) => f.t === 'e2e' && f.id === id && f.step === 'init'));
  } finally {
    await fixture.close();
  }
});

test('the transcript binds: a wrong rs fails message 1', async () => {
  const fixture = await e2eFixture();
  const { burrow, client } = fixture;
  const seen = watch(burrow);
  try {
    const impostor = await generateNoiseKeyPair();
    await client.open({ remoteStaticPublicKey: impostor.publicKey, awaitResponse: false });
    await until(() => seen.errors.length === 1);
    assert.equal(seen.opens.length, 0);
    assert.equal(await client.quiet(), true);
  } finally {
    await fixture.close();
  }
});

test('the transcript binds: a Client that lies about its static fails message 1', async () => {
  const fixture = await e2eFixture();
  const { burrow, client } = fixture;
  const seen = watch(burrow);
  try {
    // `ss` is computed with the private half, and the public half is what the
    // Burrow mixes: presenting someone else's static breaks message 1's payload.
    const other = await generateNoiseKeyPair();
    await client.open({
      staticKeyPair: { privateKey: fixture.clientStatic.privateKey, publicKey: other.publicKey },
      awaitResponse: false,
    });
    await until(() => seen.errors.length === 1);
    assert.equal(seen.opens.length, 0);
    assert.equal(await client.quiet(), true);
  } finally {
    await fixture.close();
  }
});

test('cipher states are directional: a frame reflected to its sender is rejected', async () => {
  const fixture = await e2eFixture();
  const { burrow, client } = fixture;
  const seen = watch(burrow);
  try {
    await client.open();
    await until(() => seen.opens.length === 1);

    client.sendKeepalive();
    const sent = client.sent.at(-1);
    await until(() => seen.receipts.length === 1);

    // The relay reflects the Client's own ciphertext back at it.
    burrow.e2eSendCiphertext(seen.opens[0], sent.ct);
    const reflected = await client.waitFor((f) => f.t === 'e2e' && f.step === 'transport');
    assert.throws(() => client.receiveFrame(reflected), /authentication failed/);
    assert.equal(client.session.isPoisoned, true);
  } finally {
    await fixture.close();
  }
});

test('a replayed transport frame poisons the session permanently', async () => {
  const fixture = await e2eFixture();
  const { burrow, client } = fixture;
  const seen = watch(burrow);
  try {
    await client.open();
    await until(() => seen.opens.length === 1);

    client.sendKeepalive();
    const first = client.sent.at(-1);
    await until(() => seen.receipts.length === 1);

    client.sendFrame(first);
    await until(() => seen.errors.length === 1);
    assert.equal(seen.opens[0].session.isPoisoned, true);

    // And the session stays dead for traffic that would otherwise be valid.
    client.sendKeepalive();
    await until(() => seen.errors.length === 2);
    assert.equal(seen.receipts.length, 1, 'nothing decrypted after the replay');
  } finally {
    await fixture.close();
  }
});

test('a reordered transport frame poisons the session', async () => {
  const fixture = await e2eFixture();
  const { burrow, client } = fixture;
  const seen = watch(burrow);
  try {
    await client.open();
    await until(() => seen.opens.length === 1);

    // Two frames produced in order, delivered in the other one.
    const first = client.session.sendKeepalive();
    const second = client.session.sendControl({ second: true });
    client.sendCiphertext(second);
    await until(() => seen.errors.length === 1);
    client.sendCiphertext(first);
    await until(() => seen.errors.length === 2);
    assert.equal(seen.receipts.length, 0, 'a gap is a decrypt failure, not a reorder buffer');
  } finally {
    await fixture.close();
  }
});

test('a 100 KiB application message chunks across frames and reassembles byte-exact', async () => {
  const fixture = await e2eFixture();
  const { burrow, client } = fixture;
  try {
    await establish(fixture);
    const seen = watch(burrow);

    const message = new Uint8Array(100 * 1024);
    for (let i = 0; i < message.length; i++) message[i] = (i * 131) & 0xff;
    const frames = client.sendApp(message);
    assert.ok(frames > 1, 'a 100 KiB message needs more than one Noise message');
    await until(() => seen.receipts.length === frames);

    const assembled = seen.receipts.flatMap((r) => r.receipt.messages);
    assert.equal(assembled.length, 1);
    assert.deepEqual(assembled[0], message);
    // Every relayed ciphertext stayed inside the envelope's own bound.
    for (const frame of client.sent.filter((f) => f.step === 'transport')) {
      assert.ok(frame.ct.length <= MAX_E2E_CIPHERTEXT_LENGTH);
    }
  } finally {
    await fixture.close();
  }
});

test('an application message declaring more than 1 MiB is a hard failure', async () => {
  const fixture = await e2eFixture();
  const { burrow, client } = fixture;
  const seen = watch(burrow);
  try {
    await client.open();
    await until(() => seen.opens.length === 1);

    // A perfectly authenticated stream body whose length prefix is over the
    // cap: only the framing can reject it, and it must destroy the session.
    const overCap = 1024 * 1024 + 1;
    const body = Uint8Array.of(
      0x01,
      (overCap >>> 24) & 0xff,
      (overCap >>> 16) & 0xff,
      (overCap >>> 8) & 0xff,
      overCap & 0xff,
    );
    client.sendCiphertext(client.noise.send.encryptWithAd(EMPTY, body));
    await until(() => seen.errors.length === 1);
    assert.match(String(seen.errors[0].error), /1 MiB/);
    assert.equal(seen.opens[0].session.isPoisoned, true);
  } finally {
    await fixture.close();
  }
});

test('keepalives and control messages are one fixed size each', async () => {
  const fixture = await e2eFixture();
  const { burrow, client } = fixture;
  try {
    await establish(fixture);
    const seen = watch(burrow);
    const before = client.sent.length;

    client.sendKeepalive();
    client.sendControl({ outcome: 'approved' });
    client.sendControl({ outcome: 'denied', reason: 'x'.repeat(500) });
    await until(() => seen.receipts.length === 3);

    const [keepalive, small, large] = client.sent.slice(before).filter((f) => f.step === 'transport');
    // kind byte + 32 zero bytes + tag, and kind byte + 4096 + tag.
    assert.equal(fromBase64Url(keepalive.ct).length, 1 + 32 + 16);
    assert.equal(fromBase64Url(small.ct).length, 1 + 4096 + 16);
    assert.equal(
      fromBase64Url(large.ct).length,
      fromBase64Url(small.ct).length,
      'padding is what makes an approval and a denial the same size on the wire',
    );
  } finally {
    await fixture.close();
  }
});

test('teardown: a closed Client socket tells the Burrow client-gone', async () => {
  const fixture = await e2eFixture();
  const { burrow, client } = fixture;
  const seen = watch(burrow);
  try {
    await client.open();
    await until(() => seen.opens.length === 1);
    const { clientId } = seen.opens[0];

    client.close();
    await until(() => burrow.frames.some((f) => f.t === 'client-gone' && f.clientId === clientId));
    assert.equal(burrow.e2eEntry(clientId), undefined, 'the ceremony went with the client');
  } finally {
    await fixture.close();
  }
});

test('teardown: a replaced Burrow is burrow-gone and its late frames are dropped', async () => {
  const fixture = await e2eFixture();
  const { burrow, client } = fixture;
  const seen = watch(burrow);
  try {
    await client.open();
    await until(() => seen.opens.length === 1);
    const entry = seen.opens[0];

    const replacement = await fixture.replacementBurrow();
    const replaced = watch(replacement);
    await client.waitFor((f) => f.t === 'burrow-gone');
    const closed = await burrow.closed;
    assert.equal(closed.code, WS_CLOSE_BURROW_REPLACED);

    // The displaced socket speaks for nobody: the hub's map already points at
    // the replacement, so a late transport frame is not forwarded.
    burrow.e2eSendCiphertext(entry, entry.session.sendKeepalive());
    assert.equal(await client.quiet(), true);

    // The replacement is reachable, and its ceremonies are its own: a restarted
    // Burrow has no memory of the session the Client held with its predecessor.
    await client.open();
    await until(() => replaced.opens.length === 1);
    assert.notDeepEqual(replaced.opens[0].session.handshakeHash, entry.session.handshakeHash);
  } finally {
    await fixture.close();
  }
});

test('a Burrow e2e frame for a Client bound elsewhere is not forwarded', async () => {
  const fixture = await e2eFixture();
  const { burrow, client } = fixture;
  const seen = watch(burrow);
  try {
    await client.open();
    await until(() => seen.opens.length === 1);
    const entry = seen.opens[0];

    // The Client rebinds to a different Burrow; the first one is told so.
    const second = await fixture.secondBurrow();
    await client.open({ burrowId: second.burrowId });
    await until(() => burrow.frames.some((f) => f.t === 'client-gone'));

    burrow.e2eSendCiphertext(entry, entry.session.sendKeepalive());
    assert.equal(await client.quiet(), true, 'the old Burrow cannot reach the client');
  } finally {
    await fixture.close();
  }
});

test('the relay is opaque: no plaintext, static, or handshake hash crosses it', async () => {
  const fixture = await e2eFixture();
  const { burrow, client, burrowStatic, clientStatic } = fixture;
  const MARKER = 'DORMOUSE-PLAINTEXT-ORACLE-9f3a';
  const opens = [];
  burrow.on('e2e-open', (ev) => opens.push(ev));
  try {
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
      ['burrow static', burrowStatic.publicKey],
      ['client static', clientStatic.publicKey],
      ['handshake hash', client.session.handshakeHash],
    ]) {
      assert.equal(view.includes(toBase64Url(key)), false, `${what} must never appear`);
    }
    // What it *does* see is routing only.
    assert.ok(view.includes(fixture.enrollment.burrowId));
  } finally {
    await fixture.close();
  }
});

test('tampering with message 1 is rejected by the Burrow, and the relay cannot tell', async () => {
  const fixture = await e2eFixture();
  const { burrow, client } = fixture;
  const seen = watch(burrow);
  try {
    const id = newE2eId();
    await client.open({ id, tamper: (ct) => flip(ct), awaitResponse: false });
    await until(() => seen.errors.length === 1);
    assert.equal(seen.opens.length, 0);
    assert.equal(await client.quiet(), true);
    // Forwarded, unexamined, exactly as the untampered one would have been.
    assert.ok(burrow.frames.some((f) => f.t === 'e2e' && f.id === id && f.step === 'init'));
  } finally {
    await fixture.close();
  }
});

test('tampering with message 2 is rejected by the Client', async () => {
  const fixture = await e2eFixture();
  const { burrow, client } = fixture;
  const seen = watch(burrow);
  try {
    const { handshake, id } = await client.open({ awaitResponse: false });
    const response = await client.waitFor(
      (f) => f.t === 'e2e' && f.id === id && f.step === 'response',
    );
    await until(() => seen.opens.length === 1);
    await assert.rejects(
      () => handshake.readMessage(fromBase64Url(flip(response.ct))),
      /authentication failed/,
    );
    // The Burrow still believes it completed — which is why the Client's first
    // transport payload, not `Split`, is what authorizes anything.
    assert.equal(seen.opens.length, 1);
  } finally {
    await fixture.close();
  }
});

test('tampering with a transport frame is rejected and poisons the session', async () => {
  const fixture = await e2eFixture();
  const { burrow, client } = fixture;
  const seen = watch(burrow);
  try {
    await client.open();
    await until(() => seen.opens.length === 1);

    client.sendCiphertext(flip(toBase64Url(client.session.sendKeepalive())));
    await until(() => seen.errors.length === 1);
    assert.match(String(seen.errors[0].error), /authentication failed/);
    assert.equal(seen.opens[0].session.isPoisoned, true);
  } finally {
    await fixture.close();
  }
});

test('the relay refuses malformed e2e frames before they reach the Burrow', async () => {
  const fixture = await e2eFixture();
  const { burrow, client, enrollment } = fixture;
  try {
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
  } finally {
    await fixture.close();
  }
});

test('a transport pipelined behind its init is handled after it, not beside it', async () => {
  const fixture = await e2eFixture();
  const { burrow, client } = fixture;
  const seen = watch(burrow);
  try {
    // Reading message 1 awaits three times before the session is recorded. A
    // Burrow that handled socket frames concurrently would run this transport
    // against a Map that does not hold the ceremony yet and answer "no e2e
    // session" — the wrong diagnosis, and in stage 4 a dropped first payload.
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
  } finally {
    await fixture.close();
  }
});

test('a transport frame before any init is dropped, not forwarded', async () => {
  const fixture = await e2eFixture();
  const { burrow, client, enrollment } = fixture;
  try {
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
  } finally {
    await fixture.close();
  }
});

test('a transport frame outside the binding is dropped, not forwarded', async () => {
  const fixture = await e2eFixture();
  const { burrow, client } = fixture;
  const seen = watch(burrow);
  try {
    await client.open();
    await until(() => seen.opens.length === 1);
    const second = await fixture.secondBurrow();

    // A transport frame naming a Burrow this Client is not bound to.
    const before = second.frames.length;
    client.sendCiphertext(client.session.sendKeepalive(), {});
    client.sendFrame({ ...client.sent.at(-1), burrowId: second.burrowId });
    assert.equal(await client.quiet(), true);
    assert.equal(second.frames.length, before, 'transport never binds a Burrow');
  } finally {
    await fixture.close();
  }
});
