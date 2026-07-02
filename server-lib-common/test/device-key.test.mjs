import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fromBase64Url,
  generateDeviceKeyPair,
  importDevicePublicKey,
  signDeviceChallenge,
  toBase64Url,
  verifyDeviceChallengeSignature,
} from '../dist/index.js';

const CONTEXT = {
  hostId: 'host-1',
  challenge: toBase64Url(Uint8Array.of(1, 2, 3, 4)),
  devicePublicKey: '', // filled per-test
};

async function signedContext(keyPair, overrides = {}) {
  const context = { ...CONTEXT, devicePublicKey: keyPair.devicePublicKey, ...overrides };
  const signature = await signDeviceChallenge(keyPair.privateKey, context);
  return { context, signature };
}

test('device public key is a 65-byte uncompressed P-256 point', async () => {
  const keyPair = await generateDeviceKeyPair();
  const raw = fromBase64Url(keyPair.devicePublicKey);
  assert.equal(raw.length, 65);
  assert.equal(raw[0], 0x04);
});

test('the private key is non-extractable', async () => {
  const keyPair = await generateDeviceKeyPair();
  assert.equal(keyPair.privateKey.extractable, false);
  await assert.rejects(globalThis.crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
});

test('sign/verify round-trips', async () => {
  const keyPair = await generateDeviceKeyPair();
  const { context, signature } = await signedContext(keyPair);
  assert.equal(await verifyDeviceChallengeSignature(context, signature), true);
});

test('two generated devices have distinct identities', async () => {
  const [a, b] = await Promise.all([generateDeviceKeyPair(), generateDeviceKeyPair()]);
  assert.notEqual(a.devicePublicKey, b.devicePublicKey);
});

test('verification fails for a signature from a different device', async () => {
  const [a, b] = await Promise.all([generateDeviceKeyPair(), generateDeviceKeyPair()]);
  // b signs, but the context claims a's identity.
  const context = { ...CONTEXT, devicePublicKey: a.devicePublicKey };
  const signature = await signDeviceChallenge(b.privateKey, context);
  assert.equal(await verifyDeviceChallengeSignature(context, signature), false);
});

test('verification is bound to the host id (domain separation)', async () => {
  const keyPair = await generateDeviceKeyPair();
  const { context, signature } = await signedContext(keyPair);
  assert.equal(
    await verifyDeviceChallengeSignature({ ...context, hostId: 'host-2' }, signature),
    false,
  );
});

test('verification is bound to the challenge', async () => {
  const keyPair = await generateDeviceKeyPair();
  const { context, signature } = await signedContext(keyPair);
  const otherChallenge = toBase64Url(Uint8Array.of(9, 9, 9, 9));
  assert.equal(
    await verifyDeviceChallengeSignature({ ...context, challenge: otherChallenge }, signature),
    false,
  );
});

test('a tampered signature fails', async () => {
  const keyPair = await generateDeviceKeyPair();
  const { context, signature } = await signedContext(keyPair);
  const bytes = fromBase64Url(signature);
  bytes[0] ^= 0x01;
  assert.equal(await verifyDeviceChallengeSignature(context, toBase64Url(bytes)), false);
});

test('verification returns false (not throws) on garbage inputs', async () => {
  const keyPair = await generateDeviceKeyPair();
  const { context, signature } = await signedContext(keyPair);
  assert.equal(
    await verifyDeviceChallengeSignature({ ...context, devicePublicKey: 'not-a-key' }, signature),
    false,
  );
  assert.equal(await verifyDeviceChallengeSignature(context, 'not-a-signature!'), false);
  assert.equal(await verifyDeviceChallengeSignature(context, ''), false);
});

test('importDevicePublicKey round-trips a generated identity', async () => {
  const keyPair = await generateDeviceKeyPair();
  const imported = await importDevicePublicKey(keyPair.devicePublicKey);
  assert.equal(imported.type, 'public');
});

test('importDevicePublicKey rejects malformed identities', async () => {
  await assert.rejects(importDevicePublicKey(toBase64Url(Uint8Array.of(1, 2, 3))));
});
