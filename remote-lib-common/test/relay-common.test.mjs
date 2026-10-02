/**
 * The helpers both Relays share (`src/remote/relay-common.ts`). Each Relay's
 * route suite drives them end to end; these pin the pieces on their own.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';

import {
  MAX_PASSKEY_LABEL_LENGTH,
  RELAY_BEARER_LENGTH,
  checkRegistration,
  decodeClientData,
  isRelayBearer,
  parseBearer,
  readJson,
  verifySigninAssertion,
  importableSpkiP256,
  admissiblePushSubscription,
  normalizeChallenge,
  pocketContentSecurityPolicy,
  reducePasskeyLabel,
  toBase64Url,
  utf8Encode,
} from '../dist/index.js';
import { SimAuthenticator, randomSecret, registrationClientData } from './harness/actors.mjs';

const ORIGIN = 'https://relay.example';
const RP_ID = 'relay.example';
const encode = (value) => toBase64Url(utf8Encode(JSON.stringify(value)));
/** `point` with the low bit of `y` flipped: 65 bytes, `0x04`-led, and not on P-256. */
const offCurve = (point) => {
  const bad = Buffer.from(point);
  bad[64] ^= 1;
  return bad;
};

test('admissiblePushSubscription admits only keys a sender can encrypt to, padded or not', async () => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const point = ecdh.getPublicKey();
  const auth = randomBytes(16);
  const padded = (bytes) => bytes.toString('base64');
  const payload = (keys) => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys });
  for (const keys of [
    { p256dh: point.toString('base64url'), auth: auth.toString('base64url') },
    { p256dh: padded(point), auth: padded(auth) },
  ])
    assert.equal(await admissiblePushSubscription(payload(keys)), true, JSON.stringify(keys));
  const ok = { p256dh: point.toString('base64url'), auth: auth.toString('base64url') };
  for (const keys of [
    // A compressed point, a point without its prefix, and 65 bytes not led by 0x04.
    { ...ok, p256dh: ecdh.getPublicKey(undefined, 'compressed').toString('base64url') },
    { ...ok, p256dh: point.subarray(1).toString('base64url') },
    { ...ok, p256dh: Buffer.concat([Buffer.from([2]), point.subarray(1)]).toString('base64url') },
    // The right shape, off the curve: every send to it would fail with DataError.
    { ...ok, p256dh: offCurve(point).toString('base64url') },
    { ...ok, p256dh: 'BFakeP256dhKey' },
    { ...ok, auth: randomBytes(15).toString('base64url') },
    { ...ok, auth: randomBytes(17).toString('base64url') },
    { ...ok, auth: 'FakeAuthSecret' },
    { ...ok, auth: `${auth.toString('base64url').slice(0, -1)}!` },
    { ...ok, p256dh: '' },
    { ...ok, auth: undefined },
  ])
    assert.equal(await admissiblePushSubscription(payload(keys)), false, JSON.stringify(keys));
});

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

test('parseBearer and isRelayBearer: the minted 32-byte shape, from a Bearer header only', () => {
  const token = randomSecret();
  assert.equal(token.length, RELAY_BEARER_LENGTH);
  assert.equal(parseBearer(`Bearer ${token}`), token);
  for (const header of [undefined, null, '', `bearer ${token}`, `Basic ${token}`, `Bearer ${token} x`, 'Bearer '])
    assert.equal(parseBearer(header), null, String(header));
  assert.equal(isRelayBearer(token), true);
  for (const bad of [token.slice(1), `${token}A`, `${token.slice(1)}!`, 7, undefined])
    assert.equal(isRelayBearer(bad), false, String(bad));
});

test('readJson answers the body or null, never throws', async () => {
  const request = (json) => ({ req: { json } });
  assert.deepEqual(await readJson(request(async () => ({ a: 1 }))), { a: 1 });
  assert.equal(await readJson(request(async () => { throw new SyntaxError('x'); })), null);
});

/** A registration body for `authenticator` that passes every check. */
async function registration(overrides = {}) {
  const authenticator = await SimAuthenticator.create({ rpId: RP_ID });
  return {
    credentialId: authenticator.credentialId,
    publicKey: authenticator.publicKey,
    clientDataJSON: registrationClientData({ challenge: 'AAEC', origin: ORIGIN }),
    label: '  Phone\u0007 ',
    ...overrides,
  };
}

test('checkRegistration runs its checks in order, redeeming the challenge before the origin', async () => {
  const redeemed = [];
  const redeem = (challenge) => (redeemed.push(challenge), true);
  const body = await registration();
  assert.deepEqual(await checkRegistration(body, { origin: ORIGIN, redeem }), {
    ok: true,
    credentialId: body.credentialId,
    publicKey: body.publicKey,
    label: 'Phone',
  });
  const refused = (status, error) => ({ ok: false, status, error });
  // Each case breaks one check and every later one; the first check's refusal answers.
  const cases = [
    [{ clientDataJSON: '***', publicKey: 'AAAA' }, refused(400, 'malformed clientDataJSON'), false],
    [
      { clientDataJSON: registrationClientData({ challenge: 'AAEC', origin: 'x', type: 'webauthn.get' }) },
      refused(400, 'clientData type must be webauthn.create'),
      false,
    ],
    [
      { clientDataJSON: registrationClientData({ challenge: '!!', origin: 'https://evil.example' }) },
      refused(400, 'unrecognized or expired challenge'),
      false,
    ],
    [
      { clientDataJSON: registrationClientData({ challenge: 'AAEC', origin: 'https://evil.example' }), publicKey: 'AAAA' },
      refused(400, 'origin mismatch'),
      true,
    ],
    [{ publicKey: 'AAAA', credentialId: '***' }, refused(400, 'unimportable public key'), true],
    [{ credentialId: 'not base64url!' }, refused(400, 'malformed credentialId'), true],
  ];
  for (const [overrides, expected, redeems] of cases) {
    redeemed.length = 0;
    assert.deepEqual(await checkRegistration({ ...body, ...overrides }, { origin: ORIGIN, redeem }), expected);
    assert.equal(redeemed.length, redeems ? 1 : 0, expected.error);
  }
  // A challenge that does not redeem stops the checks there.
  assert.deepEqual(
    await checkRegistration({ ...body, publicKey: 'AAAA' }, { origin: ORIGIN, redeem: () => false }),
    refused(400, 'unrecognized or expired challenge'),
  );
  // The challenge is canonicalized before it redeems.
  redeemed.length = 0;
  await checkRegistration(
    { ...body, clientDataJSON: registrationClientData({ challenge: 'AAE=', origin: ORIGIN }) },
    { origin: ORIGIN, redeem },
  );
  assert.deepEqual(redeemed, ['AAE']);
});

test('verifySigninAssertion spends the challenge before verifying, and verifies under the policy', async () => {
  const authenticator = await SimAuthenticator.create({ rpId: RP_ID, userVerification: false });
  const challenge = randomSecret();
  const assertion = await authenticator.assert({ challenge, origin: ORIGIN });
  const passkey = { publicKey: authenticator.publicKey };
  const steps = (live, policy = {}) => {
    const log = [];
    return {
      log,
      findPasskey: async (id) => (log.push(`find ${id}`), id === authenticator.credentialId ? passkey : undefined),
      consumeChallenge: (value) => (log.push(`consume ${value}`), live),
      policy: { origin: ORIGIN, rpId: RP_ID, ...policy },
    };
  };
  const ok = steps(true);
  assert.deepEqual(await verifySigninAssertion(assertion, ok), { ok: true, passkey });
  assert.deepEqual(ok.log, [`find ${authenticator.credentialId}`, `consume ${challenge}`]);

  const refused = (status, error) => ({ ok: false, status, error });
  assert.deepEqual(await verifySigninAssertion(undefined, steps(true)), refused(400, 'malformed assertion'));
  assert.deepEqual(
    await verifySigninAssertion({ ...assertion, credentialId: 'other' }, steps(true)),
    refused(404, 'unknown credential'),
  );
  assert.deepEqual(
    await verifySigninAssertion({ ...assertion, clientDataJSON: '***' }, steps(true)),
    refused(400, 'malformed clientDataJSON'),
  );
  assert.deepEqual(await verifySigninAssertion(assertion, steps(false)), refused(400, 'unrecognized or expired challenge'));
  // A forged signature is refused only after its challenge was spent: it never replays.
  const forged = await authenticator.assert({
    challenge,
    origin: ORIGIN,
    tamper: { signWith: await SimAuthenticator.foreignSigningKey() },
  });
  const spent = steps(true);
  assert.deepEqual(await verifySigninAssertion(forged, spent), refused(401, 'assertion rejected: signature-invalid'));
  assert.equal(spent.log.at(-1), `consume ${challenge}`);
  // The UV policy reaches the verifier.
  assert.deepEqual(
    await verifySigninAssertion(assertion, steps(true, { requireUserVerification: true })),
    refused(401, 'assertion rejected: user-verification-missing'),
  );
});
