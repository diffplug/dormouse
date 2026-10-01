/**
 * The helpers both Relays share (`src/remote/relay-common.ts`). Each Relay's
 * route suite drives them end to end; these pin the pieces on their own.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_PASSKEY_LABEL_LENGTH,
  decodeClientData,
  importableSpkiP256,
  normalizeChallenge,
  pocketContentSecurityPolicy,
  reducePasskeyLabel,
  toBase64Url,
  utf8Encode,
} from '../dist/index.js';

const encode = (value) => toBase64Url(utf8Encode(JSON.stringify(value)));

test('decodeClientData answers an object or null', () => {
  assert.deepEqual(decodeClientData(encode({ type: 'webauthn.create' })), { type: 'webauthn.create' });
  for (const bad of [undefined, 42, '***', toBase64Url(utf8Encode('not json')), encode(null), encode('x')])
    assert.equal(decodeClientData(bad), null, String(bad));
});

test('normalizeChallenge canonicalizes padding and refuses what is not base64url', () => {
  assert.equal(normalizeChallenge('AAEC'), 'AAEC');
  assert.equal(normalizeChallenge('AAE='), 'AAE');
  assert.equal(normalizeChallenge(7), null);
  assert.equal(normalizeChallenge('!!'), null);
});

test('importableSpkiP256 admits a P-256 SPKI and nothing else', async () => {
  const { publicKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const spki = toBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', publicKey)));
  assert.equal(await importableSpkiP256(spki), true);
  const { publicKey: other } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign']);
  const p384 = toBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', other)));
  for (const bad of [p384, 'AAAA', undefined]) assert.equal(await importableSpkiP256(bad), false);
});

test('reducePasskeyLabel bounds, cleans, and never refuses', () => {
  assert.equal(reducePasskeyLabel('  My\u0007 phone‮  '), 'My phone');
  assert.equal(Array.from(reducePasskeyLabel('😀'.repeat(200))).length, MAX_PASSKEY_LABEL_LENGTH);
  assert.equal(reducePasskeyLabel(undefined), '');
});

test("pocketContentSecurityPolicy names only the origin's own socket", () => {
  const policy = pocketContentSecurityPolicy('https://relay.example');
  assert.match(policy, /connect-src 'self' wss:\/\/relay\.example(;|$)/);
  assert.match(policy, /script-src 'self' 'wasm-unsafe-eval'(;|$)/);
  assert.match(pocketContentSecurityPolicy('http://localhost:8787'), /connect-src 'self' ws:\/\/localhost:8787(;|$)/);
});
