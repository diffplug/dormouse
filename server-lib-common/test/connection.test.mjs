import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateDeviceKeyPair, signDeviceChallenge, toBase64Url } from '../dist/index.js';
import { FakeClock, SimAuthenticator, SimClient, SimHost } from './harness/actors.mjs';

const RP_ID = 'dormouse.dev';
const ORIGIN = 'https://dormouse.dev';
const ACCOUNT = 'account-1';

/** A host with one fully paired client, ready to connect. */
async function pairedSetup(options = {}) {
  const clock = new FakeClock();
  const host = new SimHost({ hostId: 'host-1', rpId: RP_ID, origin: ORIGIN, clock, ...options });
  const authenticator = await SimAuthenticator.create({ rpId: RP_ID });
  const client = await SimClient.create({ label: 'iPhone Safari', origin: ORIGIN });
  await client.pair(host, { accountId: ACCOUNT, authenticator });
  return { clock, host, authenticator, client };
}

async function connect(setup, tamper = {}) {
  const { host, client, authenticator } = setup;
  const request = await client.buildConnectRequest(host, {
    accountId: ACCOUNT,
    authenticator,
    tamper,
  });
  return host.handleConnect(request);
}

test('a fully valid request is allowed', async () => {
  const setup = await pairedSetup();
  const decision = await connect(setup);
  assert.deepEqual(decision.failures, []);
  assert.equal(decision.allowed, true);
  assert.equal(decision.record.devicePublicKey, setup.client.deviceKey.devicePublicKey);
  assert.equal(decision.record.label, 'iPhone Safari');
  assert.equal(decision.passkey.ok, true);
});

test('each connection needs its own challenge — replaying a request is denied', async () => {
  const setup = await pairedSetup();
  const request = await setup.client.buildConnectRequest(setup.host, {
    accountId: ACCOUNT,
    authenticator: setup.authenticator,
  });
  assert.equal((await setup.host.handleConnect(request)).allowed, true);
  const replay = await setup.host.handleConnect(request);
  assert.equal(replay.allowed, false);
  assert.ok(replay.failures.includes('challenge-invalid'));
});

test('an expired challenge is denied', async () => {
  const setup = await pairedSetup({ ttlMs: 1000 });
  const request = await setup.client.buildConnectRequest(setup.host, {
    accountId: ACCOUNT,
    authenticator: setup.authenticator,
  });
  setup.clock.advance(1000);
  const decision = await setup.host.handleConnect(request);
  assert.equal(decision.allowed, false);
  assert.ok(decision.failures.includes('challenge-invalid'));
});

test('a made-up challenge is denied even if everything else is consistent', async () => {
  const setup = await pairedSetup();
  const forged = toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  const { host, client, authenticator } = setup;
  const assertion = await authenticator.assert({ challenge: forged, origin: ORIGIN });
  const deviceSignature = await signDeviceChallenge(client.deviceKey.privateKey, {
    hostId: host.hostId,
    challenge: forged,
    devicePublicKey: client.deviceKey.devicePublicKey,
  });
  const decision = await host.handleConnect({
    accountId: ACCOUNT,
    devicePublicKey: client.deviceKey.devicePublicKey,
    challenge: forged,
    deviceSignature,
    passkey: { publicKey: authenticator.publicKey, assertion },
  });
  assert.deepEqual(decision.failures, ['challenge-invalid']);
});

test('a tampered passkey assertion is denied', async () => {
  const setup = await pairedSetup();
  const decision = await connect(setup, { assertion: { origin: 'https://evil.example' } });
  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.failures, ['passkey-assertion-invalid']);
  assert.deepEqual(decision.passkey, { ok: false, reason: 'origin-mismatch' });
});

test('an unpaired passkey is denied even from a paired device', async () => {
  const setup = await pairedSetup();
  const newPasskey = await SimAuthenticator.create({ rpId: RP_ID });
  const request = await setup.client.buildConnectRequest(setup.host, {
    accountId: ACCOUNT,
    authenticator: newPasskey,
  });
  const decision = await setup.host.handleConnect(request);
  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.failures, ['passkey-not-paired']);
});

test('an unpaired device is denied even with a paired passkey', async () => {
  const setup = await pairedSetup();
  const stranger = await SimClient.create({ label: 'Attacker', origin: ORIGIN });
  const request = await stranger.buildConnectRequest(setup.host, {
    accountId: ACCOUNT,
    authenticator: setup.authenticator,
  });
  const decision = await setup.host.handleConnect(request);
  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.failures, ['device-not-paired']);
});

test('passkey and device paired separately — but never together — is denied', async () => {
  const setup = await pairedSetup();
  // A second client pairs with a second passkey; both halves are now known
  // to the host, but on different records.
  const otherAuthenticator = await SimAuthenticator.create({ rpId: RP_ID });
  const otherClient = await SimClient.create({ label: 'MacBook Chrome', origin: ORIGIN });
  await otherClient.pair(setup.host, { accountId: ACCOUNT, authenticator: otherAuthenticator });
  const request = await otherClient.buildConnectRequest(setup.host, {
    accountId: ACCOUNT,
    authenticator: setup.authenticator, // first client's passkey
  });
  const decision = await setup.host.handleConnect(request);
  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.failures, ['pairing-mismatch']);
});

test('a substituted passkey public key is denied', async () => {
  const setup = await pairedSetup();
  // Same credential id in the assertion, but a different key pair — as if a
  // compromised server re-registered the credential with an attacker key.
  const impostor = await SimAuthenticator.create({ rpId: RP_ID });
  impostor.credentialId = setup.authenticator.credentialId;
  const request = await setup.client.buildConnectRequest(setup.host, {
    accountId: ACCOUNT,
    authenticator: impostor,
  });
  const decision = await setup.host.handleConnect(request);
  assert.equal(decision.allowed, false);
  assert.ok(decision.failures.includes('passkey-key-mismatch'));
});

test('a malformed passkey public key denies cleanly instead of throwing', async () => {
  const setup = await pairedSetup();
  // Paired credential + paired device (a compromised server knows both), but
  // garbage where the SPKI key belongs. Must be a decision, never a crash.
  const request = await setup.client.buildConnectRequest(setup.host, {
    accountId: ACCOUNT,
    authenticator: setup.authenticator,
  });
  const decision = await setup.host.handleConnect({
    ...request,
    passkey: { ...request.passkey, publicKey: '!!!not-base64url!!!' },
  });
  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.failures, ['passkey-assertion-invalid', 'passkey-key-mismatch']);
  assert.deepEqual(decision.passkey, { ok: false, reason: 'public-key-invalid' });
});

test('a request for a different account than the pairing is denied', async () => {
  const setup = await pairedSetup();
  const decision = await connect(setup, { request: { accountId: 'account-2' } });
  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.failures, ['account-mismatch']);
});

test('a bad device signature is denied', async () => {
  const setup = await pairedSetup();
  const decision = await connect(setup, { request: { deviceSignature: 'AAAA' } });
  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.failures, ['device-signature-invalid']);
});

test('a device signature scoped to another host is denied', async () => {
  const setup = await pairedSetup();
  const decision = await connect(setup, { signForHostId: 'host-2' });
  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.failures, ['device-signature-invalid']);
});

test('a signature from a different device key is denied', async () => {
  const setup = await pairedSetup();
  const foreignKey = await generateDeviceKeyPair();
  const { challenge } = setup.host.issueChallenge();
  const assertion = await setup.authenticator.assert({ challenge, origin: ORIGIN });
  const deviceSignature = await signDeviceChallenge(foreignKey.privateKey, {
    hostId: setup.host.hostId,
    challenge,
    devicePublicKey: setup.client.deviceKey.devicePublicKey, // claims the paired identity
  });
  const decision = await setup.host.handleConnect({
    accountId: ACCOUNT,
    devicePublicKey: setup.client.deviceKey.devicePublicKey,
    challenge,
    deviceSignature,
    passkey: { publicKey: setup.authenticator.publicKey, assertion },
  });
  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.failures, ['device-signature-invalid']);
});

test('a revoked device is denied', async () => {
  const setup = await pairedSetup();
  setup.host.acl.revokeDevice(setup.client.deviceKey.devicePublicKey);
  const decision = await connect(setup);
  assert.equal(decision.allowed, false);
  assert.ok(decision.failures.includes('device-not-paired'));
});

test('every failing layer is reported, not just the first', async () => {
  const setup = await pairedSetup();
  const stranger = await SimClient.create({ label: 'Attacker', origin: 'https://evil.example' });
  const strangerPasskey = await SimAuthenticator.create({ rpId: RP_ID });
  const request = await stranger.buildConnectRequest(setup.host, {
    accountId: ACCOUNT,
    authenticator: strangerPasskey,
    tamper: { request: { challenge: 'AAAA', deviceSignature: 'AAAA' } },
  });
  const decision = await setup.host.handleConnect(request);
  assert.equal(decision.allowed, false);
  assert.deepEqual(
    [...decision.failures].sort(),
    [
      'challenge-invalid',
      'device-not-paired',
      'device-signature-invalid',
      'passkey-assertion-invalid',
      'passkey-not-paired',
    ],
  );
});

test('a denied decision never carries the ACL record', async () => {
  const setup = await pairedSetup();
  const decision = await connect(setup, { request: { accountId: 'account-2' } });
  assert.equal(decision.record, null);
});

test('userVerified is surfaced for policy decisions and logging', async () => {
  const setup = await pairedSetup();
  const decision = await connect(setup, { assertion: { userVerified: false } });
  assert.equal(decision.allowed, true);
  assert.equal(decision.passkey.userVerified, false);
});

test('requireUserVerification policy rejects presence-only assertions', async () => {
  const setup = await pairedSetup({ policy: { requireUserVerification: true } });
  const decision = await connect(setup, { assertion: { userVerified: false } });
  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.failures, ['passkey-assertion-invalid']);
  assert.deepEqual(decision.passkey, { ok: false, reason: 'user-verification-missing' });
});
