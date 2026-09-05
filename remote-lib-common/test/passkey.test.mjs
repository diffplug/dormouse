import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hashPasskeyPublicKey,
  toBase64Url,
  utf8Encode,
  verifyPasskeyAssertion,
} from '../dist/index.js';
import { SimAuthenticator } from './harness/actors.mjs';

const RP_ID = 'dormouse.dev';
const ORIGIN = 'https://dormouse.dev';
const CHALLENGE = toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)));

const EXPECTED = { challenge: CHALLENGE, origin: ORIGIN, rpId: RP_ID };

async function makeAssertion(tamper = {}, authenticatorOpts = {}) {
  const authenticator = await SimAuthenticator.create({ rpId: RP_ID, ...authenticatorOpts });
  const assertion = await authenticator.assert({ challenge: CHALLENGE, origin: ORIGIN, tamper });
  return { authenticator, assertion };
}

test('a well-formed assertion verifies', async () => {
  const { authenticator, assertion } = await makeAssertion();
  const result = await verifyPasskeyAssertion(assertion, authenticator.publicKey, EXPECTED);
  assert.deepEqual(result, { ok: true, userPresent: true, userVerified: true, signCount: 1 });
});

test('signCount reflects successive assertions', async () => {
  const authenticator = await SimAuthenticator.create({ rpId: RP_ID });
  await authenticator.assert({ challenge: CHALLENGE, origin: ORIGIN });
  const second = await authenticator.assert({ challenge: CHALLENGE, origin: ORIGIN });
  const result = await verifyPasskeyAssertion(second, authenticator.publicKey, EXPECTED);
  assert.equal(result.ok, true);
  assert.equal(result.signCount, 2);
});

test('accepts a padded challenge encoding in clientDataJSON', async () => {
  const { authenticator, assertion } = await makeAssertion({ challenge: `${CHALLENGE}==` });
  const result = await verifyPasskeyAssertion(assertion, authenticator.publicKey, EXPECTED);
  assert.equal(result.ok, true);
});

test('rejects the wrong challenge', async () => {
  const other = toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  const { authenticator, assertion } = await makeAssertion({ challenge: other });
  const result = await verifyPasskeyAssertion(assertion, authenticator.publicKey, EXPECTED);
  assert.deepEqual(result, { ok: false, reason: 'challenge-mismatch' });
});

test('rejects the wrong origin', async () => {
  const { authenticator, assertion } = await makeAssertion({ origin: 'https://evil.example' });
  const result = await verifyPasskeyAssertion(assertion, authenticator.publicKey, EXPECTED);
  assert.deepEqual(result, { ok: false, reason: 'origin-mismatch' });
});

test('accepts any origin from the allowlist', async () => {
  const { authenticator, assertion } = await makeAssertion({ origin: 'https://beta.dormouse.dev' });
  const result = await verifyPasskeyAssertion(assertion, authenticator.publicKey, {
    ...EXPECTED,
    origin: [ORIGIN, 'https://beta.dormouse.dev'],
  });
  assert.equal(result.ok, true);
});

test('rejects a registration (webauthn.create) assertion', async () => {
  const { authenticator, assertion } = await makeAssertion({ type: 'webauthn.create' });
  const result = await verifyPasskeyAssertion(assertion, authenticator.publicKey, EXPECTED);
  assert.deepEqual(result, { ok: false, reason: 'client-data-type' });
});

test('rejects the wrong relying party', async () => {
  const { authenticator, assertion } = await makeAssertion({ rpId: 'evil.example' });
  const result = await verifyPasskeyAssertion(assertion, authenticator.publicKey, EXPECTED);
  assert.deepEqual(result, { ok: false, reason: 'rp-id-mismatch' });
});

test('rejects when user presence is missing', async () => {
  const { authenticator, assertion } = await makeAssertion({ userPresent: false });
  const result = await verifyPasskeyAssertion(assertion, authenticator.publicKey, EXPECTED);
  assert.deepEqual(result, { ok: false, reason: 'user-presence-missing' });
});

test('requireUserVerification demands the UV flag', async () => {
  const { authenticator, assertion } = await makeAssertion({ userVerified: false });
  const relaxed = await verifyPasskeyAssertion(assertion, authenticator.publicKey, EXPECTED);
  assert.equal(relaxed.ok, true);
  assert.equal(relaxed.userVerified, false);
  const strict = await verifyPasskeyAssertion(assertion, authenticator.publicKey, {
    ...EXPECTED,
    requireUserVerification: true,
  });
  assert.deepEqual(strict, { ok: false, reason: 'user-verification-missing' });
});

test('rejects a signature from a different key', async () => {
  const foreign = await SimAuthenticator.foreignSigningKey();
  const { authenticator, assertion } = await makeAssertion({ signWith: foreign });
  const result = await verifyPasskeyAssertion(assertion, authenticator.publicKey, EXPECTED);
  assert.deepEqual(result, { ok: false, reason: 'signature-invalid' });
});

test('rejects a verification against the wrong public key', async () => {
  const { assertion } = await makeAssertion();
  const other = await SimAuthenticator.create({ rpId: RP_ID });
  const result = await verifyPasskeyAssertion(assertion, other.publicKey, EXPECTED);
  assert.deepEqual(result, { ok: false, reason: 'signature-invalid' });
});

test('rejects a tampered signature without throwing', async () => {
  const { authenticator, assertion } = await makeAssertion();
  const result = await verifyPasskeyAssertion(
    { ...assertion, signature: 'AAAA' },
    authenticator.publicKey,
    EXPECTED,
  );
  assert.deepEqual(result, { ok: false, reason: 'signature-invalid' });
});

test('rejects malformed clientDataJSON', async () => {
  const { authenticator, assertion } = await makeAssertion();
  for (const clientDataJSON of ['!!!', toBase64Url(utf8Encode('not json')), toBase64Url(utf8Encode('"str"'))]) {
    const result = await verifyPasskeyAssertion(
      { ...assertion, clientDataJSON },
      authenticator.publicKey,
      EXPECTED,
    );
    assert.deepEqual(result, { ok: false, reason: 'client-data-malformed' });
  }
});

test('rejects truncated or malformed authenticatorData', async () => {
  const { authenticator, assertion } = await makeAssertion();
  for (const authenticatorData of ['!!!', toBase64Url(new Uint8Array(36))]) {
    const result = await verifyPasskeyAssertion(
      { ...assertion, authenticatorData },
      authenticator.publicKey,
      EXPECTED,
    );
    assert.deepEqual(result, { ok: false, reason: 'authenticator-data-malformed' });
  }
});

test('rejects an unparseable public key', async () => {
  const { assertion } = await makeAssertion();
  const result = await verifyPasskeyAssertion(assertion, toBase64Url(Uint8Array.of(1, 2, 3)), EXPECTED);
  assert.deepEqual(result, { ok: false, reason: 'public-key-invalid' });
});

test('hashPasskeyPublicKey is deterministic and key-specific', async () => {
  const a = await SimAuthenticator.create({ rpId: RP_ID });
  const b = await SimAuthenticator.create({ rpId: RP_ID });
  assert.equal(await hashPasskeyPublicKey(a.publicKey), await hashPasskeyPublicKey(a.publicKey));
  assert.notEqual(await hashPasskeyPublicKey(a.publicKey), await hashPasskeyPublicKey(b.publicKey));
});
