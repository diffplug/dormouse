/**
 * Both end-to-end ceremonies driven through the real Relay
 * (`docs/specs/remote-security-model.md` -> `## Future` -> **Scope:
 * e2e-client-burrow**, stage 4): a phone scans a Burrow's QR, registers a passkey
 * off the setup token that QR carries, signs in, pairs over IK against the
 * invitation key, and then connects against the Burrow static it pinned.
 *
 * Nothing is stubbed but the transport is loopback: real WebAuthn
 * (`SimAuthenticator`), the real `/api/reauth/*` routes behind every presence
 * proof, the real relay, and the real Noise suite on both sides. The denial
 * cases are the point of the file — each one is a code a Client maps to fixed
 * copy, and none of them may say which half of the check failed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  API_ROUTES,
  MAX_TOKENS_PER_BURROW,
  REMOTE_METHODS,
  SELFHOST_ACCOUNT_ID,
  fromBase64Url,
  generateNoiseKeyPair,
  hashPasskeyPublicKey,
  toBase64Url,
} from 'remote-lib-common';

import {
  enrollBurrow,
  freshApp,
  newAuthenticator,
  register,
  signin,
  startRelay,
} from './helpers.mjs';
import { FakeClient } from './harness/fake-client.mjs';
import { FakeBurrow } from './harness/fake-burrow.mjs';

const BURROW_LABEL = 'Ned Laptop';

/** A well-formed base64url 32-byte value that is nobody's real handshake hash. */
function foreignHash() {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * A live Relay, one enrolled Burrow holding a Noise static and connected to the
 * relay, and one phone that scanned its QR: registered off the invitation's own
 * setup token, signed in, and holding a `/ws/client` socket.
 *
 * `autoApprove` is off by default — the two-digit confirmation is a person
 * typing what the phone displays, and every interesting case is about what
 * happens when those digits differ.
 */
async function ceremonyFixture({ autoApprove = false } = {}) {
  const created = await freshApp();
  const server = await startRelay(created);
  const { body: enrollment } = await enrollBurrow(created.app);
  const burrowStatic = await generateNoiseKeyPair();
  const burrow = new FakeBurrow({
    relayUrl: server.wsUrl,
    burrowToken: enrollment.burrowToken,
    burrowId: enrollment.burrowId,
    origin: created.origin,
    rpId: created.rpId,
    label: BURROW_LABEL,
    autoApprove,
    noiseStaticKeyPair: burrowStatic,
  });
  await burrow.ready;

  const opened = [burrow];
  const fixture = {
    app: created.app,
    server,
    created,
    enrollment,
    burrow,
    burrowStatic,
    /** Mint a Relay setup token and wrap it in one Burrow invitation. */
    async invite() {
      const res = await created.app.request(API_ROUTES.burrowSetupToken, {
        method: 'POST',
        headers: { Authorization: `Bearer ${enrollment.burrowToken}` },
      });
      const { token, expiresAt } = await res.json();
      return burrow.mintInvitation({ setupToken: token, expiresAt });
    },
    /**
     * A phone: a passkey registered off `credential` (the setup password when
     * the case is not about scanning), a sign-in session, and its own per-Burrow
     * Noise static — different Burrows, and different browsers, never share one.
     */
    async phone({ credential, label = 'iPhone Safari' } = {}) {
      const authenticator = await newAuthenticator();
      const registered = await register(
        created.app,
        authenticator,
        credential ? { credential } : {},
      );
      assert.equal(registered.status, 200, await registered.text());
      const { res } = await signin(created.app, authenticator);
      const { sessionToken } = await res.json();
      const client = new FakeClient({
        relayUrl: server.wsUrl,
        sessionToken,
        burrowId: enrollment.burrowId,
        staticKeyPair: await generateNoiseKeyPair(),
        burrowStaticPublicKey: burrowStatic.publicKey,
        origin: created.origin,
        rpId: created.rpId,
        label,
      });
      await client.ready;
      opened.push(client);
      return { authenticator, sessionToken, client };
    },
    close: async () => {
      for (const conn of opened) conn.close();
      await server.close();
    },
  };
  return fixture;
}

/** Type `code` at the Burrow the moment its approval modal would open. */
function typeAtBurrow(burrow, code) {
  burrow.once('pairing-request', ({ clientId }) => burrow.confirmPairing(clientId, code));
}

// --- The whole loop ---------------------------------------------------------

test('a phone scans, registers off the token, pairs, and is told everything it pins', async () => {
  const fixture = await ceremonyFixture();
  try {
    const invitation = await fixture.invite();
    // The QR's setup token is what registers the passkey, so pairing and
    // account setup ride one scanned credential.
    const { authenticator, client } = await fixture.phone({
      credential: { setupToken: invitation.setupToken },
    });

    typeAtBurrow(fixture.burrow, '42');
    const paired = await client.pair({ invitation, authenticator, code: '42' });

    assert.equal(paired.ok, true, JSON.stringify(paired.outcome));
    assert.deepEqual(paired.outcome, {
      ok: true,
      // The pin every later connection runs IK against — deliberately absent
      // from the QR, so a first-time Client learns it only inside the session.
      burrowStaticPublicKey: toBase64Url(fixture.burrowStatic.publicKey),
      // The Burrow's local label exists nowhere on the Relay.
      burrowLabel: BURROW_LABEL,
      accountId: SELFHOST_ACCOUNT_ID,
      passkeyCredentialId: authenticator.credentialId,
      passkeyPublicKeyHash: await hashPasskeyPublicKey(authenticator.publicKey),
      deliveryId: paired.outcome.deliveryId,
    });
    assert.match(paired.outcome.deliveryId, /^[A-Za-z0-9_-]{43}$/, '32 bytes, base64url');

    // One record, binding all four identities plus the delivery capability.
    const [record] = fixture.burrow.acl.activeRecords();
    assert.equal(record.burrowId, fixture.enrollment.burrowId);
    assert.equal(record.passkeyCredentialId, authenticator.credentialId);
    assert.equal(record.clientStaticPublicKey, toBase64Url(client.staticKeyPair.publicKey));
    assert.equal(record.deliveryId, paired.outcome.deliveryId);
    assert.equal(record.label, 'iPhone Safari');

    // The invitation is spent whatever the outcome: a code answered once can
    // never be reserved by a second phone.
    assert.equal(fixture.burrow.invitationState(invitation.inviteId), 'consumed');
  } finally {
    await fixture.close();
  }
});

test('evicting at the cap reports what the code was doing, as the real Burrow does', async () => {
  // The harness exists to fail where a real Burrow would, so it has to make the
  // same `dropped`-vs-`consumed` call `BurrowRuntime.#retireInvitation` makes:
  // `dropped` says nobody scanned it, and reporting that for a code a phone is
  // mid-ceremony against would tell the panel to offer a replacement.
  const fixture = await ceremonyFixture();
  try {
    const events = [];
    fixture.burrow.on('invitation', (e) => events.push(e));

    const scanned = await fixture.invite();
    const { client } = await fixture.phone({
      credential: { setupToken: scanned.setupToken },
    });
    // The IK handshake only: the invitation is now `reserved`, not yet spent.
    await client.openPairing(scanned);
    assert.equal(fixture.burrow.invitationState(scanned.inviteId), 'reserved');

    const untouched = await fixture.invite();
    events.length = 0;
    // Mint past the cap so both of the above are evicted by insertion order.
    for (let i = 0; i < MAX_TOKENS_PER_BURROW; i += 1) await fixture.invite();

    assert.deepEqual(
      events.filter((e) => e.inviteId === scanned.inviteId),
      [{ inviteId: scanned.inviteId, state: 'consumed' }],
    );
    assert.deepEqual(
      events.filter((e) => e.inviteId === untouched.inviteId),
      [{ inviteId: untouched.inviteId, state: 'dropped' }],
    );
  } finally {
    await fixture.close();
  }
});

test('a paired phone connects and speaks protocol-v1 inside the session', async () => {
  const fixture = await ceremonyFixture({ autoApprove: true });
  try {
    const invitation = await fixture.invite();
    const { authenticator, client } = await fixture.phone({
      credential: { setupToken: invitation.setupToken },
    });
    assert.equal((await client.pair({ invitation, authenticator })).ok, true);

    const connected = await client.connect({ authenticator });
    assert.equal(connected.ok, true, JSON.stringify(connected.outcome));
    assert.deepEqual(connected.outcome, { ok: true, burrowLabel: BURROW_LABEL });

    // protocol-v1 rides the established session's byte stream; nothing about it
    // changes (docs/specs/remote-api.md).
    const hello = await client.remoteRequest({
      requestId: 'r1',
      method: REMOTE_METHODS.hello,
      params: { protocolVersion: 1, viewer: 'phone' },
    });
    assert.equal(hello.ok, true);
    assert.deepEqual(hello.result, {
      protocolVersion: 1,
      burrowId: fixture.enrollment.burrowId,
      grants: { input: true, layout: false },
    });

    // The relay never learned any of it: it forwards ciphertext it cannot
    // decode, and the hello text never crossed in the clear.
    const view = JSON.stringify([...client.sent, ...client.frames]);
    assert.equal(view.includes(REMOTE_METHODS.hello), false);
  } finally {
    await fixture.close();
  }
});

// --- Every denial stage 4 can produce ---------------------------------------

test('confirmation-mismatch: the digits typed at the Burrow are not the ones displayed', async () => {
  const fixture = await ceremonyFixture();
  try {
    const invitation = await fixture.invite();
    const { authenticator, client } = await fixture.phone({
      credential: { setupToken: invitation.setupToken },
    });

    typeAtBurrow(fixture.burrow, '99');
    const paired = await client.pair({ invitation, authenticator, code: '42' });
    assert.deepEqual(paired.outcome, { ok: false, code: 'confirmation-mismatch' });
    assert.deepEqual(fixture.burrow.acl.activeRecords(), []);

    // Exactly one attempt: the invitation is spent, so typing the right digits
    // now reaches nothing.
    assert.equal(fixture.burrow.invitationState(invitation.inviteId), 'consumed');
  } finally {
    await fixture.close();
  }
});

test('user-denied: the person at the Burrow refuses', async () => {
  const fixture = await ceremonyFixture();
  try {
    const invitation = await fixture.invite();
    const { authenticator, client } = await fixture.phone({
      credential: { setupToken: invitation.setupToken },
    });

    fixture.burrow.once('pairing-request', ({ clientId }) => fixture.burrow.denyPairing(clientId));
    const paired = await client.pair({ invitation, authenticator });
    assert.deepEqual(paired.outcome, { ok: false, code: 'user-denied' });
    assert.deepEqual(fixture.burrow.acl.activeRecords(), []);
  } finally {
    await fixture.close();
  }
});

test('presence-rejected: a proof bound to a handshake this Burrow never ran', async () => {
  const fixture = await ceremonyFixture({ autoApprove: true });
  try {
    const invitation = await fixture.invite();
    const { authenticator, client } = await fixture.phone({
      credential: { setupToken: invitation.setupToken },
    });

    // The Relay happily mints a nonce for any well-formed binding — it is not
    // the authority. The Burrow builds `expected` from its OWN transcript, which
    // is what makes an assertion produced for one ceremony useless in another.
    const paired = await client.pair({
      invitation,
      authenticator,
      binding: {
        kind: 'pairing',
        burrowId: fixture.enrollment.burrowId,
        handshakeHash: foreignHash(),
        passkeyCredentialId: authenticator.credentialId,
      },
    });
    assert.deepEqual(paired.outcome, { ok: false, code: 'presence-rejected' });
    assert.deepEqual(fixture.burrow.acl.activeRecords(), []);
  } finally {
    await fixture.close();
  }
});

test('presence-rejected on a connection: a proof bound to another transcript', async () => {
  const fixture = await ceremonyFixture({ autoApprove: true });
  try {
    const invitation = await fixture.invite();
    const { authenticator, client } = await fixture.phone({
      credential: { setupToken: invitation.setupToken },
    });
    assert.equal((await client.pair({ invitation, authenticator })).ok, true);

    const opened = await client.openConnection();
    const presence = await client.presenceProof({
      binding: {
        kind: 'connection',
        burrowId: fixture.enrollment.burrowId,
        connectionId: opened.connectionId,
        burrowChallenge: opened.burrowChallenge,
        handshakeHash: foreignHash(),
        passkeyCredentialId: authenticator.credentialId,
      },
      authenticator,
    });
    client.sendControl({ presence });
    const frame = await client.nextTransport();
    assert.deepEqual(opened.session.receive(fromBase64Url(frame.ct)), {
      kind: 'control',
      value: { ok: false, code: 'presence-rejected' },
    });
  } finally {
    await fixture.close();
  }
});

test('pairing-required: an unpaired Client static, even with a registered passkey', async () => {
  const fixture = await ceremonyFixture({ autoApprove: true });
  try {
    // Never paired at all: the passkey is on the account and the Burrow static is
    // public, which models an attacker who already knows both.
    const { authenticator, client } = await fixture.phone();
    const connected = await client.connect({ authenticator });
    assert.deepEqual(connected.outcome, { ok: false, code: 'pairing-required' });
  } finally {
    await fixture.close();
  }
});

test('pairing-required: halves on different records are not authorization', async () => {
  const fixture = await ceremonyFixture({ autoApprove: true });
  try {
    // Two pairings on this Burrow: (passkey A, static A) and (passkey B, static B).
    const inviteA = await fixture.invite();
    const first = await fixture.phone({ credential: { setupToken: inviteA.setupToken } });
    assert.equal(
      (await first.client.pair({ invitation: inviteA, authenticator: first.authenticator })).ok,
      true,
    );

    const inviteB = await fixture.invite();
    const second = await fixture.phone({ credential: { setupToken: inviteB.setupToken } });
    assert.equal(
      (await second.client.pair({ invitation: inviteB, authenticator: second.authenticator })).ok,
      true,
    );
    assert.equal(fixture.burrow.acl.activeRecords().length, 2);

    // Passkey A on browser B: each half is paired, but never together, so no
    // record holds both — and the denial says only `pairing-required`.
    const crossed = await second.client.connect({
      authenticator: first.authenticator,
      staticKeyPair: second.client.staticKeyPair,
    });
    assert.deepEqual(crossed.outcome, { ok: false, code: 'pairing-required' });

    // Sanity: the same browser with its own passkey still connects.
    assert.equal((await second.client.connect({ authenticator: second.authenticator })).ok, true);
  } finally {
    await fixture.close();
  }
});

test('protocol-rejected: the first control on a connection is not a ConnectionRequestV1', async () => {
  const fixture = await ceremonyFixture({ autoApprove: true });
  try {
    const { client } = await fixture.phone();
    const opened = await client.openConnection();
    client.sendControl({ hello: 'not a connection request' });
    const frame = await client.nextTransport();
    assert.deepEqual(opened.session.receive(fromBase64Url(frame.ct)), {
      kind: 'control',
      value: { ok: false, code: 'protocol-rejected' },
    });
  } finally {
    await fixture.close();
  }
});

// --- Fixed-size outcomes ----------------------------------------------------

test('an approval and a denial are the same number of bytes on the wire', async () => {
  const fixture = await ceremonyFixture();
  try {
    const approvedInvite = await fixture.invite();
    const approved = await fixture.phone({
      credential: { setupToken: approvedInvite.setupToken },
    });
    typeAtBurrow(fixture.burrow, '07');
    const yes = await approved.client.pair({
      invitation: approvedInvite,
      authenticator: approved.authenticator,
      code: '07',
    });
    assert.equal(yes.ok, true);

    const deniedInvite = await fixture.invite();
    const denied = await fixture.phone();
    fixture.burrow.once('pairing-request', ({ clientId }) => fixture.burrow.denyPairing(clientId));
    const no = await denied.client.pair({
      invitation: deniedInvite,
      authenticator: denied.authenticator,
    });
    assert.equal(no.ok, false);

    // The success carries a Burrow static, a label, three passkey fields and a
    // delivery id; the denial carries one word. NUL padding is what keeps the
    // relay from reading the answer off a length.
    assert.equal(yes.ct.length, no.ct.length);
    assert.equal(fromBase64Url(yes.ct).length, 1 + 4096 + 16);

    // The connection outcomes match each other too.
    const okConnect = await approved.client.connect({ authenticator: approved.authenticator });
    assert.equal(okConnect.ok, true);
    const refused = await denied.client.connect({ authenticator: denied.authenticator });
    assert.equal(refused.ok, false);
    assert.equal(okConnect.ct.length, refused.ct.length);
  } finally {
    await fixture.close();
  }
});
