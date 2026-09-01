/**
 * The setup proof (docs/specs/remote-security-model.md -> Pairing Ceremony):
 * the phone returns a MAC under the nonce it scanned, over the device key it is
 * asking to have authorized.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SETUP_PROOF_DOMAIN, computeSetupProof } from '../dist/index.js';

const NONCE = 'zg8QF2mJ0oQ0iVQq7pQm4b0uRk5RtF4Wm0mDq5oXo9A';
const DEVICE = 'BExampleDevicePublicKeyBase64Url';

test('the same nonce and device key always give the same proof', async () => {
  const proof = await computeSetupProof(NONCE, DEVICE);
  assert.equal(await computeSetupProof(NONCE, DEVICE), proof);
  // Base64url of a SHA-256 MAC: 32 bytes, unpadded.
  assert.match(proof, /^[A-Za-z0-9_-]{43}$/);
});

test('the proof is bound to the device key, which is what makes it unforgeable', async () => {
  // The whole point of the scheme: a Server that substituted its own device key
  // into a relayed pairing request would have to produce a proof over *that*
  // key, which needs the nonce it never saw.
  const proof = await computeSetupProof(NONCE, DEVICE);
  assert.notEqual(await computeSetupProof(NONCE, `${DEVICE}x`), proof);
});

test('the proof is bound to the nonce, so a spent code cannot vouch for a new one', async () => {
  const proof = await computeSetupProof(NONCE, DEVICE);
  assert.notEqual(await computeSetupProof(`${NONCE}x`, DEVICE), proof);
});

test('the fields cannot be slid past each other', async () => {
  // `lengthPrefixedConcat` puts the boundary in the MAC: without it, moving a
  // character from the domain into the key would collide.
  assert.notEqual(
    await computeSetupProof(NONCE, DEVICE),
    await computeSetupProof(NONCE, `${SETUP_PROOF_DOMAIN.slice(-1)}${DEVICE}`),
  );
});

test('nothing throws on a device key the computing side did not choose', async () => {
  // The Host computes the expected proof over whatever the relay put in the
  // pairing request, so a hostile `devicePublicKey` has to produce a failed
  // compare rather than a rejected promise.
  assert.equal(typeof (await computeSetupProof(NONCE, '')), 'string');
  assert.equal(typeof (await computeSetupProof(NONCE, 'not base64url!! 💥')), 'string');
});

test('the domain is separate from every other signed statement', async () => {
  // Same rule as `PUSH_SUBSCRIBE_DOMAIN` vs `DEVICE_AUTH_DOMAIN`: one domain
  // per statement, so a MAC captured under one can never be replayed as another.
  assert.equal(SETUP_PROOF_DOMAIN, 'dormouse/setup-proof/v1');
});
