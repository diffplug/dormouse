/**
 * End-to-end scenarios for each guarantee in
 * docs/specs/remote-security-model.md § Security Guarantees, driven through
 * the full Client / Server / Host flow of the harness actors.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hashPasskeyPublicKey } from '../dist/index.js';
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
  const host = new SimHost({ hostId: 'dormouse-terminal', rpId: RP_ID, origin: ORIGIN, clock });
  const authenticator = await SimAuthenticator.create({ rpId: RP_ID });
  const client = await SimClient.create({ label: 'iPhone Safari', origin: ORIGIN });
  server.registerPasskey(ACCOUNT, authenticator);
  return { clock, server, host, authenticator, client };
}

test('pairing then connecting succeeds end to end', async () => {
  const { server, host, authenticator, client } = await world();
  const record = await client.pair(host, { accountId: ACCOUNT, authenticator });
  assert.equal(record.label, 'iPhone Safari');
  const decision = await client.connect(host, { server, accountId: ACCOUNT, authenticator });
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.failures, []);
});

test('adding a new passkey does not grant host access', async () => {
  const { server, host, authenticator, client } = await world();
  await client.pair(host, { accountId: ACCOUNT, authenticator });

  // The account gains a second passkey — entirely legitimate on the server —
  // and an attacker (or new browser) holds it on an unpaired device.
  const newPasskey = await SimAuthenticator.create({ rpId: RP_ID });
  server.registerPasskey(ACCOUNT, newPasskey);
  const newDevice = await SimClient.create({ label: 'New Browser', origin: ORIGIN });

  const decision = await newDevice.connect(host, {
    server,
    accountId: ACCOUNT,
    authenticator: newPasskey,
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.failures.includes('passkey-not-paired'));
  assert.ok(decision.failures.includes('device-not-paired'));

  // Even from the already-paired device, the new passkey alone is refused.
  const fromPairedDevice = await client.connect(host, {
    server,
    accountId: ACCOUNT,
    authenticator: newPasskey,
  });
  assert.equal(fromPairedDevice.allowed, false);
  assert.deepEqual(fromPairedDevice.failures, ['passkey-not-paired']);
});

test('compromising the server does not grant host access', async () => {
  const { host, authenticator, client } = await world();
  await client.pair(host, { accountId: ACCOUNT, authenticator });

  // The attacker controls the coordinating server: it vouches for any
  // account and any credential. They hold a passkey and device of their own.
  const evilServer = new CompromisedServer();
  const attackerPasskey = await SimAuthenticator.create({ rpId: RP_ID });
  const attacker = await SimClient.create({ label: 'Attacker', origin: ORIGIN });

  const decision = await attacker.connect(host, {
    server: evilServer,
    accountId: ACCOUNT,
    authenticator: attackerPasskey,
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.failures.includes('passkey-not-paired'));
  assert.ok(decision.failures.includes('device-not-paired'));

  // The server also has no write path into the host's ACL: nothing about the
  // attack changed what the host trusts.
  assert.equal(host.acl.records().length, 1);
  assert.equal(host.acl.records()[0].devicePublicKey, client.deviceKey.devicePublicKey);
});

test('passkey synchronization does not automatically create trusted clients', async () => {
  const { server, host, authenticator, client } = await world();
  await client.pair(host, { accountId: ACCOUNT, authenticator });

  // The same passkey syncs to a second device (same SimAuthenticator, new
  // SimClient) — exactly what iCloud Keychain does.
  const syncedDevice = await SimClient.create({ label: 'iPad Safari', origin: ORIGIN });
  const beforePairing = await syncedDevice.connect(host, {
    server,
    accountId: ACCOUNT,
    authenticator,
  });
  assert.equal(beforePairing.allowed, false);
  assert.deepEqual(beforePairing.failures, ['device-not-paired']);

  // After its own explicit pairing ceremony, the synced device is trusted —
  // and the original keeps working.
  await syncedDevice.pair(host, { accountId: ACCOUNT, authenticator });
  const afterPairing = await syncedDevice.connect(host, {
    server,
    accountId: ACCOUNT,
    authenticator,
  });
  assert.equal(afterPairing.allowed, true);
  const original = await client.connect(host, { server, accountId: ACCOUNT, authenticator });
  assert.equal(original.allowed, true);
});

test('every trusted client must be explicitly paired with every host', async () => {
  const { clock, server, host, authenticator, client } = await world();
  const otherHost = new SimHost({
    hostId: 'dormouse-terminal-2',
    rpId: RP_ID,
    origin: ORIGIN,
    clock,
  });
  await client.pair(host, { accountId: ACCOUNT, authenticator });

  const decision = await client.connect(otherHost, { server, accountId: ACCOUNT, authenticator });
  assert.equal(decision.allowed, false);
  assert.ok(decision.failures.includes('passkey-not-paired'));
  assert.ok(decision.failures.includes('device-not-paired'));

  await client.pair(otherHost, { accountId: ACCOUNT, authenticator });
  const afterPairing = await client.connect(otherHost, {
    server,
    accountId: ACCOUNT,
    authenticator,
  });
  assert.equal(afterPairing.allowed, true);
});

test('every connection requires fresh user presence', async () => {
  const { server, host, authenticator, client } = await world();
  await client.pair(host, { accountId: ACCOUNT, authenticator });

  // First connection: fine. Reusing any part of it: refused. The passkey
  // assertion and device signature are bound to a consumed challenge, so a
  // network eavesdropper (or the server itself) can replay nothing.
  const request = await client.buildConnectRequest(host, {
    accountId: ACCOUNT,
    authenticator,
  });
  assert.equal((await host.handleConnect(request)).allowed, true);

  const replayed = await host.handleConnect(request);
  assert.equal(replayed.allowed, false);
  assert.ok(replayed.failures.includes('challenge-invalid'));

  // Splicing the old (valid, signed) assertion into a fresh challenge fails
  // both signature layers: nothing signed over the old challenge transfers.
  const fresh = host.issueChallenge();
  const spliced = await host.handleConnect({ ...request, challenge: fresh.challenge });
  assert.equal(spliced.allowed, false);
  assert.ok(spliced.failures.includes('passkey-assertion-invalid'));
  assert.ok(spliced.failures.includes('device-signature-invalid'));
});

test('revoking a client cuts off access immediately', async () => {
  const { server, host, authenticator, client } = await world();
  await client.pair(host, { accountId: ACCOUNT, authenticator });
  assert.equal(
    (await client.connect(host, { server, accountId: ACCOUNT, authenticator })).allowed,
    true,
  );

  host.acl.revokeDevice(client.deviceKey.devicePublicKey);
  const afterRevocation = await client.connect(host, {
    server,
    accountId: ACCOUNT,
    authenticator,
  });
  assert.equal(afterRevocation.allowed, false);
  assert.ok(afterRevocation.failures.includes('device-not-paired'));

  // Re-pairing (a fresh ceremony) restores access.
  await client.pair(host, { accountId: ACCOUNT, authenticator });
  assert.equal(
    (await client.connect(host, { server, accountId: ACCOUNT, authenticator })).allowed,
    true,
  );
});

test('device key loss is recoverable without weakening the model', async () => {
  const { server, host, authenticator, client } = await world();
  await client.pair(host, { accountId: ACCOUNT, authenticator });

  // Browser data cleared: the device key is gone and a new one is generated.
  const lostKey = await client.loseDeviceKey();

  // The passkey still works, but the host no longer recognizes the device.
  const beforeRepairing = await client.connect(host, {
    server,
    accountId: ACCOUNT,
    authenticator,
  });
  assert.equal(beforeRepairing.allowed, false);
  assert.deepEqual(beforeRepairing.failures, ['device-not-paired']);

  // Recovery: authenticate with the passkey, re-pair, optionally revoke the
  // old key.
  await client.pair(host, { accountId: ACCOUNT, authenticator });
  host.acl.revokeDevice(lostKey);
  const afterRepairing = await client.connect(host, {
    server,
    accountId: ACCOUNT,
    authenticator,
  });
  assert.equal(afterRepairing.allowed, true);
  assert.equal(host.acl.hasActiveDevice(lostKey), false);
});

test('the host is the final authority: a denied pairing never grants access', async () => {
  const { server, host, authenticator, client } = await world();

  // The request reaches the host, but the local user denies it.
  const ticket = host.beginPairing({
    accountId: ACCOUNT,
    passkeyCredentialId: authenticator.credentialId,
    passkeyPublicKeyHash: await hashPasskeyPublicKey(authenticator.publicKey),
    devicePublicKey: client.deviceKey.devicePublicKey,
    requestedLabel: client.label,
  });
  host.denyPairing(ticket.pairingId);

  const decision = await client.connect(host, { server, accountId: ACCOUNT, authenticator });
  assert.equal(decision.allowed, false);
  assert.equal(host.acl.records().length, 0);
});

test('the server cannot pair on the user\'s behalf: pending pairings grant nothing', async () => {
  const { server, host, authenticator, client } = await world();

  // A malicious server floods the host with pairing requests; none are
  // approved locally, so none authorize anything.
  for (let i = 0; i < 3; i++) {
    host.beginPairing({
      accountId: ACCOUNT,
      passkeyCredentialId: authenticator.credentialId,
      passkeyPublicKeyHash: await hashPasskeyPublicKey(authenticator.publicKey),
      devicePublicKey: client.deviceKey.devicePublicKey,
      requestedLabel: 'Totally Legit Device',
    });
  }
  const decision = await client.connect(host, { server, accountId: ACCOUNT, authenticator });
  assert.equal(decision.allowed, false);
  assert.equal(host.acl.records().length, 0);
});
