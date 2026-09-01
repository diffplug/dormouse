/**
 * The `e2e` relay envelope driven end to end through the real server
 * (docs/specs/server.md -> Relay): one Noise IK ceremony between a fake Client
 * and a fake Host, with both statics injected by the test.
 *
 * What it proves, in the order the scope asks for it
 * (docs/specs/remote-security-model.md -> `## Future` -> **Scope:
 * e2e-client-host**, stage 3): prologue and transcript binding, directional
 * cipher states, counters, framing, teardown, relay opacity, tamper rejection,
 * and the relay's own bounds. The framing in isolation is
 * `server-lib-common/test/noise-transport.test.mjs`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_E2E_CIPHERTEXT_LENGTH,
  WS_CLOSE_HOST_REPLACED,
  e2eConnectionPrologue,
  fromBase64Url,
  generateNoiseKeyPair,
  toBase64Url,
  utf8Encode,
} from 'server-lib-common';

import { enrollHost, freshApp, ownerSession, startServer, until } from './helpers.mjs';
import { FakeClient } from './harness/fake-client.mjs';
import { FakeHost } from './harness/fake-host.mjs';
import { newE2eId } from './harness/e2e.mjs';

const EMPTY = new Uint8Array(0);

/** A live server, one Host with a Noise static, and one Client that pins it. */
async function e2eFixture() {
  const created = await freshApp();
  const server = await startServer(created);
  const { body: enrollment } = await enrollHost(created.app);
  const hostStatic = await generateNoiseKeyPair();
  const clientStatic = await generateNoiseKeyPair();
  const host = new FakeHost({
    serverUrl: server.wsUrl,
    hostToken: enrollment.hostToken,
    hostId: enrollment.hostId,
    origin: created.origin,
    rpId: created.rpId,
    noiseStaticKeyPair: hostStatic,
  });
  await host.ready;
  const { sessionToken, authenticator } = await ownerSession(created.app);
  const client = new FakeClient({
    serverUrl: server.wsUrl,
    sessionToken,
    hostId: enrollment.hostId,
    staticKeyPair: clientStatic,
    hostStaticPublicKey: hostStatic.publicKey,
    origin: created.origin,
    rpId: created.rpId,
  });
  await client.ready;
  const opened = [host, client];
  return {
    app: created.app,
    server,
    host,
    client,
    authenticator,
    enrollment,
    hostStatic,
    clientStatic,
    /** A second Host socket for the same enrollment — models a Host restart. */
    async replacementHost() {
      const replacement = new FakeHost({
        serverUrl: server.wsUrl,
        hostToken: enrollment.hostToken,
        hostId: enrollment.hostId,
        origin: created.origin,
        rpId: created.rpId,
        noiseStaticKeyPair: hostStatic,
      });
      await replacement.ready;
      opened.push(replacement);
      return replacement;
    },
    async secondHost() {
      const { body } = await enrollHost(created.app, { label: 'Second' });
      const second = new FakeHost({
        serverUrl: server.wsUrl,
        hostToken: body.hostToken,
        hostId: body.hostId,
        origin: created.origin,
        rpId: created.rpId,
        noiseStaticKeyPair: hostStatic,
      });
      await second.ready;
      opened.push(second);
      return second;
    },
    close: async () => {
      for (const conn of opened) conn.close();
      await server.close();
    },
  };
}

/**
 * Pair and connect this fixture's Client, leaving an authorized session.
 *
 * The transport cases below ride one, because that is where a Client's traffic
 * actually lives: on a *pending* connection the Host answers the first control
 * with an outcome and stops, exactly as `RemoteHost` does.
 */
async function establish(fixture) {
  const invitation = await fixture.host.mintInvitation();
  const paired = await fixture.client.pair({
    invitation,
    authenticator: fixture.authenticator,
  });
  assert.equal(paired.ok, true, JSON.stringify(paired.outcome));
  const connected = await fixture.client.connect({ authenticator: fixture.authenticator });
  assert.equal(connected.ok, true, JSON.stringify(connected.outcome));
  return connected;
}

/** Record the Host's e2e outcomes so a test can await one. */
function watch(host) {
  const receipts = [];
  const errors = [];
  const opens = [];
  host.on('e2e-receive', (ev) => receipts.push(ev));
  host.on('e2e-error', (ev) => errors.push(ev));
  host.on('e2e-open', (ev) => opens.push(ev));
  return { receipts, errors, opens };
}

/** Flip one byte of a base64url ciphertext — what a hostile relay looks like. */
function flip(ct, index = -1) {
  const bytes = fromBase64Url(ct);
  const at = index < 0 ? bytes.length + index : index;
  bytes[at] ^= 0x01;
  return toBase64Url(bytes);
}

/** Every frame the relay handled: what both peers sent and what it delivered. */
function relayView(...peers) {
  return JSON.stringify(peers.flatMap((peer) => [...peer.sent, ...peer.frames]));
}

test('an established session round-trips every transport kind through the relay', async () => {
  const fixture = await e2eFixture();
  const { host, client, clientStatic } = fixture;
  const opens = [];
  host.on('e2e-open', (ev) => opens.push(ev));
  try {
    await establish(fixture);
    // The connection handshake: both sides agree on the transcript, and IK
    // authenticated the Client's static — the key the ACL conjunction matched.
    const entry = opens.at(-1);
    assert.deepEqual(entry.session.handshakeHash, client.session.handshakeHash);
    assert.equal(entry.clientStaticPublicKey, toBase64Url(clientStatic.publicKey));

    // Client → Host, all three kinds.
    const seen = watch(host);
    const payload = utf8Encode('terminal.write rides in here');
    client.sendKeepalive();
    client.sendControl({ presence: 'proof' });
    client.sendApp(payload);
    await until(() => seen.receipts.length === 3);
    assert.equal(seen.receipts[0].receipt.kind, 'keepalive');
    assert.deepEqual(seen.receipts[1].receipt, { kind: 'control', value: { presence: 'proof' } });
    assert.deepEqual(seen.receipts[2].receipt.messages, [payload]);

    // Host → Client, on the other direction's cipher state.
    const reply = utf8Encode('terminal.data rides back');
    host.e2eSendApp(entry.clientId, reply);
    const frame = await client.nextTransport();
    assert.equal(frame.hostId, fixture.enrollment.hostId, 'the relay stamps hostId');
    assert.deepEqual(client.receiveFrame(frame).messages, [reply]);

    // An e2e session is not a legacy one: the `msg` pipe stays shut.
    const hostFramesBefore = host.frames.length;
    client.sendFrame({ t: 'msg', data: { forbidden: true } });
    assert.equal(await client.quiet(), true);
    assert.equal(host.frames.length, hostFramesBefore, 'e2e establishes no msg session');
  } finally {
    await fixture.close();
  }
});

test('the transcript binds: a wrong prologue fails message 1', async () => {
  const fixture = await e2eFixture();
  const { host, client } = fixture;
  const seen = watch(host);
  try {
    const id = newE2eId();
    await client.open({
      id,
      // The same ceremony, a different connection id in the prologue only.
      prologue: e2eConnectionPrologue(fixture.enrollment.hostId, newE2eId()),
      awaitResponse: false,
    });
    await until(() => seen.errors.length === 1);
    assert.equal(seen.opens.length, 0, 'no session was established');
    assert.equal(await client.quiet(), true, 'the Host answered nothing');
    // The relay forwarded it all the same: it cannot tell a bound transcript
    // from an unbound one, which is the point.
    assert.ok(host.frames.some((f) => f.t === 'e2e' && f.id === id && f.step === 'init'));
  } finally {
    await fixture.close();
  }
});

test('the transcript binds: a wrong rs fails message 1', async () => {
  const fixture = await e2eFixture();
  const { host, client } = fixture;
  const seen = watch(host);
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
  const { host, client } = fixture;
  const seen = watch(host);
  try {
    // `ss` is computed with the private half, and the public half is what the
    // Host mixes: presenting someone else's static breaks message 1's payload.
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
  const { host, client } = fixture;
  const seen = watch(host);
  try {
    await client.open();
    await until(() => seen.opens.length === 1);

    client.sendKeepalive();
    const sent = client.sent.at(-1);
    await until(() => seen.receipts.length === 1);

    // The relay reflects the Client's own ciphertext back at it.
    host.e2eSendCiphertext(seen.opens[0], sent.ct);
    const reflected = await client.waitFor((f) => f.t === 'e2e' && f.step === 'transport');
    assert.throws(() => client.receiveFrame(reflected), /authentication failed/);
    assert.equal(client.session.isPoisoned, true);
  } finally {
    await fixture.close();
  }
});

test('a replayed transport frame poisons the session permanently', async () => {
  const fixture = await e2eFixture();
  const { host, client } = fixture;
  const seen = watch(host);
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
  const { host, client } = fixture;
  const seen = watch(host);
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
  const { host, client } = fixture;
  try {
    await establish(fixture);
    const seen = watch(host);

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
  const { host, client } = fixture;
  const seen = watch(host);
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
  const { host, client } = fixture;
  try {
    await establish(fixture);
    const seen = watch(host);
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

test('teardown: a closed Client socket tells the Host client-gone', async () => {
  const fixture = await e2eFixture();
  const { host, client } = fixture;
  const seen = watch(host);
  try {
    await client.open();
    await until(() => seen.opens.length === 1);
    const { clientId } = seen.opens[0];

    client.close();
    await until(() => host.frames.some((f) => f.t === 'client-gone' && f.clientId === clientId));
    assert.equal(host.e2eEntry(clientId), undefined, 'the ceremony went with the client');
  } finally {
    await fixture.close();
  }
});

test('teardown: a replaced Host is host-gone and its late frames are dropped', async () => {
  const fixture = await e2eFixture();
  const { host, client } = fixture;
  const seen = watch(host);
  try {
    await client.open();
    await until(() => seen.opens.length === 1);
    const entry = seen.opens[0];

    const replacement = await fixture.replacementHost();
    const replaced = watch(replacement);
    await client.waitFor((f) => f.t === 'host-gone');
    const closed = await host.closed;
    assert.equal(closed.code, WS_CLOSE_HOST_REPLACED);

    // The displaced socket speaks for nobody: the hub's map already points at
    // the replacement, so a late transport frame is not forwarded.
    host.e2eSendCiphertext(entry, entry.session.sendKeepalive());
    assert.equal(await client.quiet(), true);

    // The replacement is reachable, and its ceremonies are its own: a restarted
    // Host has no memory of the session the Client held with its predecessor.
    await client.open();
    await until(() => replaced.opens.length === 1);
    assert.notDeepEqual(replaced.opens[0].session.handshakeHash, entry.session.handshakeHash);
  } finally {
    await fixture.close();
  }
});

test('a Host e2e frame for a Client bound elsewhere is not forwarded', async () => {
  const fixture = await e2eFixture();
  const { host, client } = fixture;
  const seen = watch(host);
  try {
    await client.open();
    await until(() => seen.opens.length === 1);
    const entry = seen.opens[0];

    // The Client rebinds to a different Host; the first one is told so.
    const second = await fixture.secondHost();
    await client.open({ hostId: second.hostId });
    await until(() => host.frames.some((f) => f.t === 'client-gone'));

    host.e2eSendCiphertext(entry, entry.session.sendKeepalive());
    assert.equal(await client.quiet(), true, 'the old Host cannot reach the client');
  } finally {
    await fixture.close();
  }
});

test('the relay is opaque: no plaintext, static, or handshake hash crosses it', async () => {
  const fixture = await e2eFixture();
  const { host, client, hostStatic, clientStatic } = fixture;
  const MARKER = 'DORMOUSE-PLAINTEXT-ORACLE-9f3a';
  const opens = [];
  host.on('e2e-open', (ev) => opens.push(ev));
  try {
    await establish(fixture);
    const seen = watch(host);
    const entry = opens.at(-1);

    client.sendControl({ note: MARKER });
    client.sendApp(utf8Encode(`app ${MARKER}`));
    host.e2eSendApp(entry.clientId, utf8Encode(`reply ${MARKER}`));
    await until(() => seen.receipts.length === 2);
    await client.nextTransport();

    const view = relayView(client, host);
    assert.equal(view.includes(MARKER), false, 'no plaintext crosses the relay');
    for (const [what, key] of [
      ['host static', hostStatic.publicKey],
      ['client static', clientStatic.publicKey],
      ['handshake hash', client.session.handshakeHash],
    ]) {
      assert.equal(view.includes(toBase64Url(key)), false, `${what} must never appear`);
    }
    // What it *does* see is routing only.
    assert.ok(view.includes(fixture.enrollment.hostId));
  } finally {
    await fixture.close();
  }
});

test('tampering with message 1 is rejected by the Host, and the relay cannot tell', async () => {
  const fixture = await e2eFixture();
  const { host, client } = fixture;
  const seen = watch(host);
  try {
    const id = newE2eId();
    await client.open({ id, tamper: (ct) => flip(ct), awaitResponse: false });
    await until(() => seen.errors.length === 1);
    assert.equal(seen.opens.length, 0);
    assert.equal(await client.quiet(), true);
    // Forwarded, unexamined, exactly as the untampered one would have been.
    assert.ok(host.frames.some((f) => f.t === 'e2e' && f.id === id && f.step === 'init'));
  } finally {
    await fixture.close();
  }
});

test('tampering with message 2 is rejected by the Client', async () => {
  const fixture = await e2eFixture();
  const { host, client } = fixture;
  const seen = watch(host);
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
    // The Host still believes it completed — which is why the Client's first
    // transport payload, not `Split`, is what authorizes anything.
    assert.equal(seen.opens.length, 1);
  } finally {
    await fixture.close();
  }
});

test('tampering with a transport frame is rejected and poisons the session', async () => {
  const fixture = await e2eFixture();
  const { host, client } = fixture;
  const seen = watch(host);
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

test('the relay refuses malformed e2e frames before they reach the Host', async () => {
  const fixture = await e2eFixture();
  const { host, client, enrollment } = fixture;
  try {
    const base = {
      t: 'e2e',
      hostId: enrollment.hostId,
      kind: 'connection',
      id: newE2eId(),
      step: 'init',
      ct: 'Zm9v',
    };
    const before = host.frames.length;
    const bad = [
      { ...base, ct: 'a'.repeat(MAX_E2E_CIPHERTEXT_LENGTH + 1) },
      { ...base, id: 'too-short' },
      { ...base, id: `${newE2eId()}x` },
      { ...base, kind: 'terminal' },
      { ...base, step: 'response' },
      { ...base, step: 'go' },
      { ...base, hostId: 'not-a-host-id' },
      { ...base, ct: '' },
    ];
    for (const frame of bad) {
      client.sendFrame(frame);
      const error = await client.waitFor((f) => f.t === 'error');
      assert.equal(error.error, 'malformed e2e frame', JSON.stringify(frame));
      client.frames.length = 0; // consume, so the next wait sees a fresh one
    }
    assert.equal(host.frames.length, before, 'nothing malformed reached the Host');

    // A well-formed frame naming a Host that is not connected is the ordinary
    // offline refusal, not a malformed one.
    client.sendFrame({ ...base, hostId: newE2eId() });
    const offline = await client.waitFor((f) => f.t === 'error');
    assert.match(offline.error, /is offline/);
  } finally {
    await fixture.close();
  }
});

test('a transport pipelined behind its init is handled after it, not beside it', async () => {
  const fixture = await e2eFixture();
  const { host, client } = fixture;
  const seen = watch(host);
  try {
    // Reading message 1 awaits three times before the session is recorded. A
    // Host that handled socket frames concurrently would run this transport
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
  const { host, client, enrollment } = fixture;
  try {
    // A well-formed transport frame from a Client that has never bound: there
    // is no binding to forward it within, so the relay drops it silently.
    const before = host.frames.length;
    client.sendFrame({
      t: 'e2e',
      hostId: enrollment.hostId,
      kind: 'connection',
      id: newE2eId(),
      step: 'transport',
      ct: 'Zm9vYmFy',
    });
    assert.equal(await client.quiet(), true, 'not even an error is answered');
    assert.equal(host.frames.length, before, 'transport never reaches an unbound Host');
  } finally {
    await fixture.close();
  }
});

test('a transport frame outside the binding is dropped, not forwarded', async () => {
  const fixture = await e2eFixture();
  const { host, client } = fixture;
  const seen = watch(host);
  try {
    await client.open();
    await until(() => seen.opens.length === 1);
    const second = await fixture.secondHost();

    // A transport frame naming a Host this Client is not bound to.
    const before = second.frames.length;
    client.sendCiphertext(client.session.sendKeepalive(), {});
    client.sendFrame({ ...client.sent.at(-1), hostId: second.hostId });
    assert.equal(await client.quiet(), true);
    assert.equal(second.frames.length, before, 'transport never binds a Host');
  } finally {
    await fixture.close();
  }
});
