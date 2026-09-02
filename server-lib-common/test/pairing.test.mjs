/**
 * What is left of `pairing.ts` after the E2E cutover: the shape guards the
 * legacy relay path still runs, the bounds both ceremonies share, and the
 * fingerprint. The Host's own ceremony is `e2e-ceremony.test.mjs`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PAIRING_FINGERPRINT_LENGTH,
  boundedPairingLabel,
  isPairStatusQuery,
  isPairingRequest,
  pairingFingerprint,
} from '../dist/index.js';

const REQUEST = {
  accountId: 'account-1',
  passkeyCredentialId: 'cred-1',
  passkeyPublicKeyHash: 'hash-1',
  devicePublicKey: 'device-1',
  requestedLabel: 'iPhone Safari',
};

test('isPairingRequest rejects a non-object, a missing field, and a wrong type', () => {
  assert.equal(isPairingRequest(undefined), false);
  assert.equal(isPairingRequest('nope'), false);
  assert.equal(isPairingRequest({ ...REQUEST, devicePublicKey: undefined }), false);
  assert.equal(isPairingRequest({ ...REQUEST, requestedLabel: { evil: true } }), false);
  assert.equal(isPairingRequest(REQUEST), true);
});

test('isPairingRequest bounds field length, not just type', () => {
  // A megabyte string is a `string`. The frame itself is uncapped (ws defaults
  // to 100 MiB), so this is the bound that stops a relay choosing how much
  // memory a pairing costs the Host.
  assert.equal(isPairingRequest({ ...REQUEST, requestedLabel: 'x'.repeat(1025) }), false);
  assert.equal(isPairingRequest({ ...REQUEST, accountId: 'x'.repeat(1025) }), false);
  assert.equal(isPairingRequest({ ...REQUEST, requestedLabel: 'x'.repeat(1024) }), true);
});

test('isPairingRequest takes setupProof as optional, bounded when present', () => {
  // Absent on the QR-less path, so its absence must not fail the guard; when a
  // scanned phone does carry one it is relay-supplied text like every other
  // field, and bounded the same way. Only the Host can say more about it.
  assert.equal(isPairingRequest({ ...REQUEST, setupProof: undefined }), true);
  assert.equal(isPairingRequest({ ...REQUEST, setupProof: 'mac-over-the-device-key' }), true);
  assert.equal(isPairingRequest({ ...REQUEST, setupProof: 42 }), false);
  assert.equal(isPairingRequest({ ...REQUEST, setupProof: 'x'.repeat(1025) }), false);
});

test('isPairStatusQuery bounds both halves of the ACL lookup key', () => {
  // Run on both sides for the reason isPairingRequest is: the Host does not
  // trust the relay that hands it one.
  const query = { passkeyCredentialId: 'cred-1', devicePublicKey: 'device-1' };
  assert.equal(isPairStatusQuery(query), true);
  assert.equal(isPairStatusQuery(null), false);
  assert.equal(isPairStatusQuery({ ...query, devicePublicKey: 42 }), false);
  assert.equal(isPairStatusQuery({ ...query, passkeyCredentialId: 'x'.repeat(1025) }), false);
});

test('boundedPairingLabel strips bidi and caps length', () => {
  const bounded = boundedPairingLabel(`‮owner${'A'.repeat(500)}`);
  assert.equal(bounded.includes('‮'), false);
  assert.ok(Array.from(bounded).length <= 64);
  assert.equal(boundedPairingLabel(undefined), '(unnamed)');
});

test('the fingerprint skips the constant prefix of a raw P-256 point', async () => {
  // base64url of an uncompressed point always starts `B` (the 0x04 tag), and
  // its second character only ever takes 16 values. Slicing from zero would
  // spend two of eight displayed characters on ~4 bits.
  const { webcrypto } = await import('node:crypto');
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const raw = Buffer.from(await webcrypto.subtle.exportKey('raw', pair.publicKey));
  const devicePublicKey = raw.toString('base64url');

  assert.equal(devicePublicKey[0], 'B');
  const fingerprint = pairingFingerprint(devicePublicKey);
  assert.equal(fingerprint.length, PAIRING_FINGERPRINT_LENGTH);
  assert.equal(fingerprint, devicePublicKey.slice(2, 2 + PAIRING_FINGERPRINT_LENGTH));
});
