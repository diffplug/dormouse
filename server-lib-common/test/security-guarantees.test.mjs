/**
 * End-to-end scenarios for each guarantee in
 * docs/specs/remote-security-model.md § Security Guarantees, driven through
 * the full Client / Server / Host flow of the harness actors — the real QR
 * grammar, the real IK handshakes, the real presence verifier, and the real
 * ACL conjunction.
 *
 * The denial a Client is *sent* is deliberately uninformative: every ACL miss
 * is `pairing-required`. Which half failed is asserted on `misses`, the Host's
 * owner-local log, which is exactly the separation these tests exist to pin.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CompromisedServer,
  FakeClock,
  SimAuthenticator,
  SimClient,
  SimHost,
  SimServer,
} from './harness/actors.mjs';

const RP_ID = 'dormouse.dev';
const ORIGIN = 'https://dormouse.dev';
const ACCOUNT = 'ned@dormouse.dev';

async function world() {
  const clock = new FakeClock();
  const server = new SimServer();
  const host = await SimHost.create({ label: 'Laptop', rpId: RP_ID, origin: ORIGIN, clock });
  const authenticator = await SimAuthenticator.create({ rpId: RP_ID });
  const client = await SimClient.create({ label: 'iPhone Safari', origin: ORIGIN, server });
  server.registerPasskey(ACCOUNT, authenticator);
  return { clock, server, host, authenticator, client };
}

test('pairing then connecting succeeds end to end', async () => {
  const { host, authenticator, client } = await world();
  const paired = await client.pair(host, { accountId: ACCOUNT, authenticator });
  assert.equal(paired.ok, true);
  assert.equal(paired.record.label, 'iPhone Safari');
  // The success carries the Host's long-term static — the Client's pin from
  // here on — its local label, and the delivery capability. None of the three
  // exists anywhere on the Server.
  assert.equal(paired.outcome.hostStaticPublicKey, host.staticPublicKey);
  assert.equal(paired.outcome.hostLabel, 'Laptop');
  assert.equal(client.pins.get(host.hostId), host.staticPublicKey);
  assert.equal(client.knownHosts.get(host.hostId).deliveryId, paired.record.deliveryId);
  // The record binds the Client static IK authenticated, not one it claimed.
  assert.equal(paired.record.clientStaticPublicKey, client.staticPublicKeyFor(host));

  const connected = await client.connect(host, { accountId: ACCOUNT, authenticator });
  assert.equal(connected.ok, true);
  assert.equal(connected.outcome.hostLabel, 'Laptop');
  assert.deepEqual(connected.misses, []);
});

test('adding a new passkey does not grant host access', async () => {
  const { server, host, authenticator, client } = await world();
  await client.pair(host, { accountId: ACCOUNT, authenticator });

  // The account gains a second passkey — entirely legitimate on the server —
  // and an attacker (or new browser) holds it in an unpaired browser profile.
  const newPasskey = await SimAuthenticator.create({ rpId: RP_ID });
  server.registerPasskey(ACCOUNT, newPasskey);
  const newBrowser = await SimClient.create({ label: 'New Browser', origin: ORIGIN, server });

  const fromNewBrowser = await newBrowser.connect(host, {
    accountId: ACCOUNT,
    authenticator: newPasskey,
  });
  assert.equal(fromNewBrowser.ok, false);
  assert.equal(fromNewBrowser.outcome.code, 'pairing-required');
  assert.ok(fromNewBrowser.misses.includes('passkey-not-paired'));
  assert.ok(fromNewBrowser.misses.includes('client-not-paired'));

  // Even from the already-paired browser, the new passkey alone is refused:
  // a passkey added after pairing grants nothing until a new local approval.
  const fromPairedBrowser = await client.connect(host, {
    accountId: ACCOUNT,
    authenticator: newPasskey,
  });
  assert.equal(fromPairedBrowser.ok, false);
  assert.deepEqual(fromPairedBrowser.misses, ['passkey-not-paired']);
});

test('compromising the server does not grant host access', async () => {
  const { host, authenticator, client } = await world();
  const paired = await client.pair(host, { accountId: ACCOUNT, authenticator });

  // The attacker controls the coordinating server: it vouches for any account
  // and mints a presence challenge for any binding. They hold a passkey and a
  // browser of their own, and the Host's static is public, so they can even
  // complete the handshake.
  const evilServer = new CompromisedServer();
  const attackerPasskey = await SimAuthenticator.create({ rpId: RP_ID });
  const attacker = await SimClient.create({ label: 'Attacker', origin: ORIGIN, server: evilServer });

  const decision = await attacker.connect(host, {
    accountId: ACCOUNT,
    authenticator: attackerPasskey,
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.outcome.code, 'pairing-required');
  assert.ok(decision.misses.includes('passkey-not-paired'));
  assert.ok(decision.misses.includes('client-not-paired'));

  // The server also has no write path into the host's ACL: nothing about the
  // attack changed what the host trusts.
  assert.equal(host.acl.records().length, 1);
  assert.equal(host.acl.records()[0].clientStaticPublicKey, client.staticPublicKeyFor(host));
  assert.equal(host.acl.records()[0].deliveryId, paired.record.deliveryId);
});

test('a compromised server cannot substitute a passkey it does hold', async () => {
  // The sharper half of server compromise: the attacker replays the *paired*
  // credential id, which they can read off any relayed binding. The record
  // stores a hash of the paired key, the assertion is verified against the
  // presented key, and the two must agree — so a passkey they can actually
  // sign with is not the one the ACL row names.
  const { host, authenticator, client } = await world();
  await client.pair(host, { accountId: ACCOUNT, authenticator });

  const evilServer = new CompromisedServer();
  const impostor = await SimAuthenticator.create({ rpId: RP_ID });
  impostor.credentialId = authenticator.credentialId;
  const attacker = await SimClient.create({ label: 'Attacker', origin: ORIGIN, server: evilServer });

  const decision = await attacker.connect(host, { accountId: ACCOUNT, authenticator: impostor });
  assert.equal(decision.ok, false);
  assert.equal(decision.outcome.code, 'pairing-required');
  // The passkey half now matches by id; the browser half never does, and the
  // key-hash compare would refuse it even if it did.
  assert.deepEqual(decision.misses, ['client-not-paired']);
});

test('passkey synchronization does not automatically create trusted clients', async () => {
  const { server, host, authenticator, client } = await world();
  await client.pair(host, { accountId: ACCOUNT, authenticator });

  // The same passkey syncs to a second device (same SimAuthenticator, new
  // SimClient) — exactly what iCloud Keychain does.
  const synced = await SimClient.create({ label: 'iPad Safari', origin: ORIGIN, server });
  const beforePairing = await synced.connect(host, { accountId: ACCOUNT, authenticator });
  assert.equal(beforePairing.ok, false);
  assert.deepEqual(beforePairing.misses, ['client-not-paired']);

  // After its own explicit pairing ceremony — a fresh QR, a fresh Client
  // static — the synced device is trusted, and the original keeps working.
  await synced.pair(host, { accountId: ACCOUNT, authenticator });
  assert.equal((await synced.connect(host, { accountId: ACCOUNT, authenticator })).ok, true);
  assert.equal((await client.connect(host, { accountId: ACCOUNT, authenticator })).ok, true);
  // Two active records, two distinct Client statics and delivery capabilities.
  const active = host.acl.activeRecords();
  assert.equal(active.length, 2);
  assert.equal(new Set(active.map((r) => r.clientStaticPublicKey)).size, 2);
  assert.equal(new Set(active.map((r) => r.deliveryId)).size, 2);
});

test('every trusted client must be explicitly paired with every host', async () => {
  const { clock, host, authenticator, client } = await world();
  const otherHost = await SimHost.create({
    label: 'Desktop',
    rpId: RP_ID,
    origin: ORIGIN,
    clock,
  });
  await client.pair(host, { accountId: ACCOUNT, authenticator });

  const decision = await client.connect(otherHost, { accountId: ACCOUNT, authenticator });
  assert.equal(decision.ok, false);
  assert.ok(decision.misses.includes('passkey-not-paired'));
  assert.ok(decision.misses.includes('client-not-paired'));

  await client.pair(otherHost, { accountId: ACCOUNT, authenticator });
  assert.equal((await client.connect(otherHost, { accountId: ACCOUNT, authenticator })).ok, true);

  // Different Hosts never share a Client key, so neither ACL can be satisfied
  // with the static the other authorized.
  assert.notEqual(client.staticPublicKeyFor(host), client.staticPublicKeyFor(otherHost));
  assert.equal(host.acl.hasActiveClient(client.staticPublicKeyFor(otherHost)), false);
  assert.equal(otherHost.acl.hasActiveClient(client.staticPublicKeyFor(host)), false);
});

test('every connection requires fresh user presence', async () => {
  const { host, authenticator, client } = await world();
  await client.pair(host, { accountId: ACCOUNT, authenticator });

  const first = await client.connect(host, { accountId: ACCOUNT, authenticator });
  assert.equal(first.ok, true);

  // Replaying the whole proof into a second connection: the binding names the
  // first connection's id, challenge, and handshake hash, none of which the
  // Host expects now. Nothing signed over the old ceremony transfers.
  const replayed = await client.connect(host, {
    accountId: ACCOUNT,
    authenticator,
    tamper: { presence: first.presence },
  });
  assert.equal(replayed.ok, false);
  assert.equal(replayed.outcome.code, 'presence-rejected');
  assert.equal(replayed.detail, 'binding-mismatch');

  // A pairing proof is not a connection proof either: the kinds differ, so a
  // ceremony that costs no Host challenge cannot authenticate one that does.
  const repaired = await client.pair(host, { accountId: ACCOUNT, authenticator });
  const crossed = await client.connect(host, {
    accountId: ACCOUNT,
    authenticator,
    tamper: { presence: repaired.presence },
  });
  assert.equal(crossed.ok, false);
  assert.equal(crossed.outcome.code, 'presence-rejected');
  assert.equal(crossed.detail, 'binding-mismatch');

  // The Host challenge is single-use whatever the outcome, so the issuer holds
  // nothing a captured request could still be replayed against.
  assert.equal(host.challenges.pendingCount, 0);
});

test('revoking a client cuts off access immediately', async () => {
  const { host, authenticator, client } = await world();
  await client.pair(host, { accountId: ACCOUNT, authenticator });
  assert.equal((await client.connect(host, { accountId: ACCOUNT, authenticator })).ok, true);

  host.acl.revokeClient(client.staticPublicKeyFor(host));
  const afterRevocation = await client.connect(host, { accountId: ACCOUNT, authenticator });
  assert.equal(afterRevocation.ok, false);
  assert.equal(afterRevocation.outcome.code, 'pairing-required');
  assert.ok(afterRevocation.misses.includes('client-not-paired'));

  // Re-pairing (a fresh ceremony, a fresh QR) restores access.
  await client.pair(host, { accountId: ACCOUNT, authenticator });
  assert.equal((await client.connect(host, { accountId: ACCOUNT, authenticator })).ok, true);
});

test('client-static loss is recoverable without weakening the model', async () => {
  const { host, authenticator, client } = await world();
  await client.pair(host, { accountId: ACCOUNT, authenticator });

  // Browser data cleared: this Host's static is gone and a fresh one replaces
  // it. The pin survives, so the Client still knows which Host it is talking
  // to — but the Host no longer recognizes the browser.
  const lost = await client.losePerHostStatic(host);
  assert.notEqual(client.staticPublicKeyFor(host), lost);

  const before = await client.connect(host, { accountId: ACCOUNT, authenticator });
  assert.equal(before.ok, false);
  assert.deepEqual(before.misses, ['client-not-paired']);

  // Recovery: scan a new QR, pair again, then revoke the stranded record.
  await client.pair(host, { accountId: ACCOUNT, authenticator });
  assert.equal(host.acl.revokeClient(lost), 1);
  assert.equal((await client.connect(host, { accountId: ACCOUNT, authenticator })).ok, true);
  assert.equal(host.acl.hasActiveClient(lost), false);
});

test('the host is the final authority: a denied pairing never grants access', async () => {
  const { host, authenticator, client } = await world();

  // The ceremony reaches the Host — the handshake completes and the presence
  // proof verifies — and the local user denies it anyway.
  const denied = await client.pair(host, { accountId: ACCOUNT, authenticator, approve: false });
  assert.equal(denied.ok, false);
  assert.equal(denied.outcome.code, 'user-denied');
  assert.equal(denied.record, null);
  assert.equal(host.acl.records().length, 0);
  assert.equal(client.pins.has(host.hostId), false);

  const decision = await client.connect(host, { accountId: ACCOUNT, authenticator });
  assert.equal(decision.ok, false);
  assert.equal(decision.outcome.code, 'pairing-required');
});

test('a mistyped confirmation code consumes the invitation and grants nothing', async () => {
  // Exactly one attempt: the human is the control, so a wrong code is a
  // terminal denial rather than a retry loop an attacker can grind.
  const { host, authenticator, client } = await world();
  const invitation = await host.mintInvitation();
  const mistyped = await client.pair(host, {
    accountId: ACCOUNT,
    authenticator,
    invitation,
    code: '17',
    typedCode: '99',
  });
  assert.equal(mistyped.ok, false);
  assert.equal(mistyped.outcome.code, 'confirmation-mismatch');
  assert.equal(host.acl.records().length, 0);
  assert.equal(host.invitationState(invitation.inviteId), 'consumed');
  await assert.rejects(
    client.pair(host, { accountId: ACCOUNT, authenticator, invitation }),
    /no live invitation/,
  );
});

test("the server cannot pair on the user's behalf: unapproved invitations grant nothing", async () => {
  const { host, authenticator, client } = await world();

  // A malicious server floods the Host with pairing requests; none are
  // approved locally, so none authorize anything and each invitation is spent.
  for (let i = 0; i < 3; i++) {
    const attempt = await client.pair(host, { accountId: ACCOUNT, authenticator, approve: false });
    assert.equal(attempt.ok, false);
  }
  const decision = await client.connect(host, { accountId: ACCOUNT, authenticator });
  assert.equal(decision.ok, false);
  assert.equal(host.acl.records().length, 0);
});

test('an expired invitation never reaches a handshake', async () => {
  // Advisory on the Client — the Host's memory stays authoritative — but a code
  // that is already dead fails at the scan rather than after a handshake.
  const { clock, host, authenticator, client } = await world();
  const invitation = await host.mintInvitation({ ttlSeconds: 60 });
  clock.advance(61_000);
  await assert.rejects(
    client.pair(host, { accountId: ACCOUNT, authenticator, invitation }),
    /cannot parse/,
  );
  assert.equal(host.acl.records().length, 0);
});

test('a QR minted by one Host cannot pair a Client served from another origin', async () => {
  // The fragment is invisible to the Server, so the origin compare in the
  // parser is the only thing that keeps a code from bootstrapping a different
  // deployment's Pocket.
  const { host, authenticator } = await world();
  const foreign = await SimClient.create({ label: 'Wrong Origin', origin: 'https://evil.example' });
  await assert.rejects(
    foreign.pair(host, { accountId: ACCOUNT, authenticator, server: new SimServer() }),
    /cannot parse/,
  );
});
