/**
 * The relay, hostile: what an operator who records, drops, reorders,
 * duplicates, modifies, and invents frames can actually obtain
 * (docs/specs/remote-security-model.md -> Burrow bounds, Security Guarantees).
 *
 * `e2e-relay.test.mjs` drives the same two peers through the *honest* relay;
 * this file replaces it with one that is trying, so the assertions are about
 * what stays impossible rather than what still works. The relay wraps the real
 * `RelayHub` — its routing is the shipped routing — and the last case removes
 * its own `ct`/`id`/shape guards to show they are defense in depth: the Burrow
 * runs the same guard on arrival and its bounds do not move.
 *
 * HTTP is a real Relay, because the presence proofs go through the real
 * `/api/reauth/*` routes; only the relay is in memory.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_CLIENT_ID_LENGTH,
  MAX_E2E_CIPHERTEXT_LENGTH,
  fromBase64Url,
  generateNoiseKeyPair,
  isE2eClientFrame,
  isE2eRelayToBurrowFrame,
  toBase64Url,
  utf8Encode,
} from 'remote-lib-common';

import { until } from './helpers.mjs';
import { e2eFixture, establish, flip, newE2eId, watch } from './harness/e2e.mjs';
import { createMaliciousRelay } from './harness/malicious-relay.mjs';

/** The shared E2E fixture, with a relay this test controls in its middle. */
function hostileFixture({ guards = true } = {}) {
  return e2eFixture({ relayFor: (burrowId) => createMaliciousRelay({ burrowId, guards }) });
}

test('a recording relay learns no decision, label, api message, or terminal byte', async () => {
  const fixture = await hostileFixture();
  const { burrow, client, relay, burrowStatic, clientStatic } = fixture;
  const MARKER = 'DORMOUSE-BURROWILE-RELAY-ORACLE-4c1d';
  try {
    await establish(fixture);
    const seen = watch(burrow);
    const entry = burrow.e2eEntry(relay.clientId);

    client.sendApp(utf8Encode(`terminal.write ${MARKER}`));
    burrow.e2eSendApp(relay.clientId, utf8Encode(`terminal.data ${MARKER}`));
    await until(() => seen.receipts.length >= 1);
    await client.nextTransport();

    const view = relay.view();
    for (const [what, secret] of [
      ['plaintext', MARKER],
      ["the Burrow's label", burrow.label],
      ['the pairing code', client.knownBurrow.deliveryId],
      ['the burrow static', toBase64Url(burrowStatic.publicKey)],
      ['the client static', toBase64Url(clientStatic.publicKey)],
      ['the handshake hash', toBase64Url(entry.session.handshakeHash)],
    ]) {
      assert.equal(view.includes(secret), false, `${what} must never cross the relay`);
    }
    // What it does see is routing: the burrowId it is already routing by.
    assert.ok(view.includes(fixture.enrollment.burrowId));
  } finally {
    await fixture.close();
  }
});

test('a relay that forges a pairing outcome is not believed', async () => {
  const fixture = await hostileFixture();
  const { burrow, client, relay } = fixture;
  try {
    const invitation = await burrow.mintInvitation();
    // Every Burrow->Client transport frame is rewritten: the relay cannot produce
    // a ciphertext the Client's own receive state accepts, so the best it can
    // do is corrupt one.
    relay.tamper = (frame, to) =>
      to === 'client' && frame.t === 'e2e' && frame.step === 'transport'
        ? [{ ...frame, ct: flip(frame.ct) }]
        : [frame];

    await assert.rejects(
      () => client.pair({ invitation, authenticator: fixture.authenticator }),
      /authentication failed/,
      'a forged outcome does not decrypt',
    );
    assert.equal(client.session.isPoisoned, true);
    assert.equal(client.pin, null, 'nothing was pinned');
    assert.equal(client.knownBurrow, null);
    // The Burrow really did approve — so the only thing the relay achieved is
    // denying its own user a pairing, which is availability, not authorization.
    assert.equal(burrow.acl.activeRecords().length, 1);
  } finally {
    await fixture.close();
  }
});

test('a relay that invents a control message poisons the session and nothing else', async () => {
  const fixture = await hostileFixture();
  const { burrow, client, relay } = fixture;
  const seen = watch(burrow);
  try {
    await establish(fixture);
    const before = burrow.attachments.size;

    // A frame the relay made up entirely, on the live connection: the only
    // thing it can choose is the ciphertext, and it cannot choose a valid one.
    relay.injectTo('burrow', {
      t: 'e2e',
      clientId: relay.clientId,
      burrowId: fixture.enrollment.burrowId,
      kind: 'connection',
      id: client.id,
      step: 'transport',
      ct: toBase64Url(new Uint8Array(64)),
    });
    await until(() => seen.errors.length === 1);
    assert.match(String(seen.errors[0].error), /authentication failed/);
    assert.equal(burrow.e2eEntry(relay.clientId).session.isPoisoned, true);
    assert.equal(burrow.attachments.size, before, 'no remote-api call was made');
  } finally {
    await fixture.close();
  }
});

test('duplicating, reordering, or dropping a transport frame is terminal, not steerable', async () => {
  for (const mode of ['duplicate', 'reorder', 'modify']) {
    const fixture = await hostileFixture();
    const { burrow, client, relay } = fixture;
    const seen = watch(burrow);
    try {
      await establish(fixture);
      const held = [];
      relay.tamper = (frame, to) => {
        if (to !== 'burrow' || frame.t !== 'e2e' || frame.step !== 'transport') return [frame];
        if (mode === 'duplicate') return [frame, frame];
        if (mode === 'modify') return [{ ...frame, ct: flip(frame.ct) }];
        // Reorder: hold the first, release it behind the second.
        held.push(frame);
        return held.length < 2 ? [] : [held[1], held[0]];
      };

      const errorsBefore = seen.errors.length;
      client.sendKeepalive();
      if (mode === 'reorder') client.sendKeepalive();
      await until(() => seen.errors.length > errorsBefore);
      assert.equal(burrow.e2eEntry(relay.clientId).session.isPoisoned, true, mode);
      // **Exactly the receiving side.** Poison follows the failed decrypt; the
      // Client's own cipher states never saw the tampered bytes, so a relay
      // cannot use one direction to take down the other.
      assert.equal(client.session.isPoisoned, false, mode);

      // And it stays dead for traffic that would otherwise be valid: there is
      // no resynchronization point for the relay to steer the stream back to.
      relay.tamper = null;
      const receiptsBefore = seen.receipts.length;
      client.sendApp(utf8Encode('after the tamper'));
      await until(() => seen.errors.length > errorsBefore + 1);
      assert.equal(seen.receipts.length, receiptsBefore, mode);
    } finally {
      await fixture.close();
    }
  }
});

test('dropping every frame denies service and nothing more', async () => {
  const fixture = await hostileFixture();
  const { burrow, client, relay } = fixture;
  try {
    relay.tamper = () => [];
    const invitation = await burrow.mintInvitation();
    await assert.rejects(
      // A short deadline: what is under test is that nothing arrives at all,
      // and the harness's two-second default would be two seconds of the suite.
      () => client.pair({ invitation, authenticator: fixture.authenticator, timeout: 100 }),
      /no matching frame in time/,
    );
    // The Burrow never saw a scan, so the code on its screen is still live and
    // the ACL is still empty: a silent relay authorizes nothing.
    assert.equal(burrow.invitationState(invitation.inviteId), 'live');
    assert.equal(burrow.acl.activeRecords().length, 0);
  } finally {
    await fixture.close();
  }
});

test('a relay with no guards at all weakens no Burrow bound', async () => {
  // The relay's `ct` / `id` / shape checks are defense in depth: the Burrow runs
  // the same guard on arrival because the routing values become map keys and
  // the ciphertext becomes WebCrypto work. Here the relay has none, so every
  // refusal below is the Burrow's own.
  const fixture = await hostileFixture({ guards: false });
  const { burrow, client, relay, enrollment } = fixture;
  const seen = watch(burrow);
  try {
    const invitation = await burrow.mintInvitation();
    const base = {
      t: 'e2e',
      clientId: relay.clientId,
      burrowId: enrollment.burrowId,
      kind: 'pairing',
      id: invitation.inviteId,
      step: 'init',
      ct: 'AAAA',
    };
    const refused = [
      { ...base, ct: 'a'.repeat(MAX_E2E_CIPHERTEXT_LENGTH + 1) },
      { ...base, ct: '' },
      { ...base, ct: 'not base64url!' },
      { ...base, id: `${newE2eId()}x` },
      { ...base, id: 'short' },
      // The two only a relay can choose: the `clientId` it stamps itself.
      { ...base, clientId: 'x'.repeat(MAX_CLIENT_ID_LENGTH + 1) },
      { ...base, clientId: 42 },
      { ...base, burrowId: 'not-a-burrow-id' },
      { ...base, kind: 'terminal' },
      { ...base, step: 'response' },
    ];
    for (const frame of refused) {
      assert.equal(isE2eRelayToBurrowFrame(frame), false, JSON.stringify(frame));
      relay.injectTo('burrow', frame);
    }
    // Plus the two a guard would have let through and the Burrow still drops
    // without decrypting: an id nothing is pending under, and transport before
    // any handshake.
    const dropped = {
      ...base,
      id: newE2eId(),
      kind: 'connection',
      step: 'transport',
      ct: toBase64Url(new Uint8Array(64)),
    };
    assert.equal(isE2eRelayToBurrowFrame(dropped), true, 'well-formed, and still refused');
    relay.injectTo('burrow', dropped);

    await until(() => seen.errors.length >= refused.length);
    assert.equal(seen.errors.length, refused.length, 'one refusal each, and no decrypt');
    for (const error of seen.errors) assert.match(String(error.error), /malformed e2e frame/);
    assert.equal(seen.opens.length, 0, 'nothing established');
    assert.equal(burrow.clients.size, 0, 'no entry under a relay-chosen key');
    assert.equal(burrow.invitationState(invitation.inviteId), 'live', 'no scanner was spent');

    // A Client sending a malformed frame through the same relay reaches the
    // Burrow unfiltered — the leg `isE2eClientFrame` would have stopped — and is
    // refused there too.
    const fromClient = { t: 'e2e', burrowId: enrollment.burrowId, kind: 'pairing', id: 'short', step: 'init', ct: 'AAAA' };
    assert.equal(isE2eClientFrame(fromClient), false);
    client.sendFrame(fromClient);
    await until(() => seen.errors.length === refused.length + 1);
    assert.equal(burrow.clients.size, 0);

    // And the honest ceremony still completes through the same guard-less
    // relay, so the assertions above are about refusal, not about a dead wire.
    const paired = await client.pair({ invitation, authenticator: fixture.authenticator });
    assert.equal(paired.ok, true, JSON.stringify(paired.outcome));
  } finally {
    await fixture.close();
  }
});
