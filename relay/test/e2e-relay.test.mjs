/**
 * The `e2e` relay envelope driven end to end through the real Relay
 * (docs/specs/relay.md -> "Routing"): one Noise IK ceremony between a fake Client
 * and a fake Burrow, with both statics injected by the test.
 *
 * What it proves, in the order the scope asks for it
 * (docs/specs/remote-security-model.md -> `## Future` -> **Scope:
 * e2e-client-burrow**, stage 3): prologue and transcript binding, directional
 * cipher states, counters, framing, and tamper rejection. Its routing half —
 * teardown, relay opacity, the binding, and the relay's own bounds — is the
 * cases every Relay passes (`remote-lib-common/test/harness/relay-parity.mjs`),
 * registered at the end. The framing in isolation is
 * `remote-lib-common/test/noise-transport.test.mjs`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_E2E_CIPHERTEXT_LENGTH,
  e2eConnectionPrologue,
  fromBase64Url,
  generateNoiseKeyPair,
  toBase64Url,
} from 'remote-lib-common';

import { until } from './helpers.mjs';
import { e2eFixture, establish, flip, newE2eId, watch } from './harness/e2e.mjs';
import { e2eCases } from '../../remote-lib-common/test/harness/relay-parity.mjs';

const EMPTY = new Uint8Array(0);


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

// The routing cases every Relay passes, driven through this one.
for (const { name, run } of e2eCases) {
  test(name, async () => {
    const fixture = await e2eFixture();
    try {
      await run(fixture);
    } finally {
      await fixture.close();
    }
  });
}
