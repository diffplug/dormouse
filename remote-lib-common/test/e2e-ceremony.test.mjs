/**
 * The control messages both end-to-end ceremonies exchange, and the one
 * presence verifier they share (docs/specs/remote-security-model.md ->
 * `## Future` -> Presence proofs, Pairing, Connection).
 *
 * The verifier is the whole of "the Burrow checks freshness itself", so every
 * failure reason gets its own case; the fixed-size control padding is the whole
 * of "the relay learns nothing from a length", so the outcome messages are
 * measured on the wire rather than argued about.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CEREMONY_FIELD_LIMIT,
  NoiseTransportSession,
  ONE_TIME_DENIAL_CODES,
  ONE_TIME_DEVICE_LABELS,
  ONE_TIME_UNKNOWN_DEVICE_LABEL,
  PAIRING_CODE_LENGTH,
  SESSION_END_V1,
  createNoiseInitiator,
  createNoiseResponder,
  e2eConnectionPrologue,
  generateNoiseKeyPair,
  hashPasskeyPublicKey,
  isConnectionOutcomeV1,
  isConnectionRequestV1,
  isOneTimeOutcomeV1,
  isOneTimeRequestV1,
  isPairingCode,
  isPairingOutcomeV1,
  isPairingRequestV1,
  isPresenceProofV1,
  isSessionEndV1,
  knownOneTimeDeviceLabel,
  presenceChallenge,
  samplePairingCode,
  toBase64Url,
  verifyPresenceProof,
} from '../dist/index.js';
import { SimAuthenticator, randomRoutingId, randomSecret } from './harness/actors.mjs';

const RP_ID = 'dormouse.dev';
const ORIGIN = 'https://dormouse.dev';
const ACCOUNT = 'ned@dormouse.dev';
const POLICY = { rpId: RP_ID, origin: ORIGIN, requireUserVerification: true };

/**
 * Base64url of exactly 32 bytes — a handshake hash, a Burrow challenge, a key
 * hash. The trailing `A` is load-bearing: 43 characters carry two spare bits,
 * and `presenceChallenge` decodes these fields, so a final character with
 * nonzero low bits is not a spelling of any byte string.
 */
const digest = (tag) => `${tag.padEnd(42, 'B')}A`;

/** Base64url of exactly 16 bytes; four spare bits, so the same rule applies. */
const routingId = (tag) => `${tag.padEnd(21, 'B')}A`;

const authenticator = await SimAuthenticator.create({ rpId: RP_ID });

function pairingBinding(overrides = {}) {
  return {
    kind: 'pairing',
    burrowId: routingId('burrow'),
    handshakeHash: digest('hh1'),
    passkeyCredentialId: authenticator.credentialId,
    ...overrides,
  };
}

function connectionBinding(overrides = {}) {
  return {
    kind: 'connection',
    burrowId: routingId('burrow'),
    connectionId: routingId('conn'),
    burrowChallenge: digest('ch1'),
    handshakeHash: digest('hh1'),
    passkeyCredentialId: authenticator.credentialId,
    ...overrides,
  };
}

/** A proof the real verifier accepts, unless `tamper` breaks exactly one thing. */
async function proofFor(binding, { relayNonce = randomSecret(), tamper = {}, who = authenticator } = {}) {
  const challenge = await presenceChallenge(binding, relayNonce);
  return {
    binding,
    relayNonce,
    accountId: ACCOUNT,
    passkeyCredentialId: who.credentialId,
    passkeyPublicKey: who.publicKey,
    assertion: await who.assert({ challenge, origin: ORIGIN, rpId: RP_ID, tamper: tamper.assertion ?? {} }),
    ...(tamper.proof ?? {}),
  };
}

// --- verifyPresenceProof ---------------------------------------------------

test('a proof over the expected binding verifies and yields the presented key hash', async () => {
  for (const binding of [pairingBinding(), connectionBinding()]) {
    const result = await verifyPresenceProof(await proofFor(binding), binding, POLICY);
    assert.deepEqual(result, {
      ok: true,
      // The assertion is verified against the *presented* key and its hash
      // returned for the ACL compare, so a compromised Relay cannot substitute
      // a passkey: the hash on the record is what the Burrow trusts.
      passkeyPublicKeyHash: await hashPasskeyPublicKey(authenticator.publicKey),
    });
  }
});

test('presence proof rejects when WebCrypto disappears or a digest fails', async () => {
  const binding = pairingBinding();
  const proof = await proofFor(binding);
  const real = globalThis.crypto;
  for (const failingDigest of [1, 2, 3, 4]) {
    let calls = 0;
    const crypto = {
      subtle: {
        digest(...args) {
          if (++calls === failingDigest) return Promise.reject(new Error('digest unavailable'));
          return real.subtle.digest(...args);
        },
        importKey: (...args) => real.subtle.importKey(...args),
        verify: (...args) => real.subtle.verify(...args),
      },
    };
    assert.deepEqual(await verifyPresenceProof(proof, binding, POLICY, crypto), {
      ok: false, reason: failingDigest === 1 ? 'challenge-underivable' : 'assertion-invalid',
    });
    assert.equal(calls, failingDigest);
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
  try {
    assert.deepEqual(await verifyPresenceProof(proof, binding, POLICY), {
      ok: false, reason: 'challenge-underivable',
    });
  } finally {
    Object.defineProperty(globalThis, 'crypto', descriptor);
  }
});

test('a proof that is not a PresenceProofV1 at all is malformed', async () => {
  const binding = pairingBinding();
  const valid = await proofFor(binding);
  for (const [why, proof] of [
    ['not an object', 'nope'],
    ['null', null],
    ['no binding', { ...valid, binding: undefined }],
    ['a binding with an extra key', { ...valid, binding: { ...binding, extra: 'x' } }],
    ['a binding of no known kind', { ...valid, binding: { ...binding, kind: 'terminal' } }],
    ['a non-string nonce', { ...valid, relayNonce: 42 }],
    ['an over-long nonce', { ...valid, relayNonce: 'a'.repeat(CEREMONY_FIELD_LIMIT + 1) }],
    ['an over-long account', { ...valid, accountId: 'a'.repeat(CEREMONY_FIELD_LIMIT + 1) }],
    ['no assertion', { ...valid, assertion: undefined }],
    ['an assertion missing a field', { ...valid, assertion: { ...valid.assertion, signature: undefined } }],
    [
      'an over-long clientDataJSON',
      { ...valid, assertion: { ...valid.assertion, clientDataJSON: 'a'.repeat(CEREMONY_FIELD_LIMIT + 1) } },
    ],
  ]) {
    const result = await verifyPresenceProof(proof, binding, POLICY);
    assert.deepEqual(result, { ok: false, reason: 'malformed' }, why);
  }
});

test('every binding field must equal the Burrow expectation, of the same kind', async () => {
  // What stops a proof for one ceremony authenticating another: the Burrow built
  // `expected` from its own state, so this compare is the freshness check.
  const pairingMutations = [
    ['burrowId', { burrowId: routingId('other') }],
    ['handshakeHash', { handshakeHash: digest('hh2') }],
    // The binding compare runs before the credential compare, so a proof for
    // another credential fails here rather than at `credential-mismatch`.
    ['passkeyCredentialId', { passkeyCredentialId: 'someone-else' }],
  ];
  for (const [field, override] of pairingMutations) {
    const proof = await proofFor(pairingBinding(override));
    assert.deepEqual(
      await verifyPresenceProof(proof, pairingBinding(), POLICY),
      { ok: false, reason: 'binding-mismatch' },
      field,
    );
  }

  const connectionMutations = [
    ['burrowId', { burrowId: routingId('other') }],
    ['connectionId', { connectionId: routingId('other') }],
    ['burrowChallenge', { burrowChallenge: digest('ch2') }],
    ['handshakeHash', { handshakeHash: digest('hh2') }],
  ];
  for (const [field, override] of connectionMutations) {
    const proof = await proofFor(connectionBinding(override));
    assert.deepEqual(
      await verifyPresenceProof(proof, connectionBinding(), POLICY),
      { ok: false, reason: 'binding-mismatch' },
      field,
    );
  }

  // A pairing proof presented at connect time, and the reverse. A `connection`
  // binding that could be read as a `pairing` one would be a pairing proof
  // replayed against a Burrow challenge it never saw.
  assert.deepEqual(await verifyPresenceProof(await proofFor(pairingBinding()), connectionBinding(), POLICY), {
    ok: false,
    reason: 'binding-mismatch',
  });
  assert.deepEqual(await verifyPresenceProof(await proofFor(connectionBinding()), pairingBinding(), POLICY), {
    ok: false,
    reason: 'binding-mismatch',
  });
});

test('the assertion and the proof must name the credential the binding does', async () => {
  // Requiring all three equal is what keeps the verified key and the bound
  // identity one identity rather than two that merely travelled together.
  const binding = pairingBinding();
  const other = await SimAuthenticator.create({ rpId: RP_ID });

  const wrongAssertion = await proofFor(binding);
  wrongAssertion.assertion = { ...wrongAssertion.assertion, credentialId: other.credentialId };
  assert.deepEqual(await verifyPresenceProof(wrongAssertion, binding, POLICY), {
    ok: false,
    reason: 'credential-mismatch',
  });

  const wrongProof = await proofFor(binding, { tamper: { proof: { passkeyCredentialId: other.credentialId } } });
  assert.deepEqual(await verifyPresenceProof(wrongProof, binding, POLICY), {
    ok: false,
    reason: 'credential-mismatch',
  });
});

test('a binding the challenge builder cannot hash is underivable, not a crash', async () => {
  // `presenceChallenge` decodes the base64url fields, so a binding carrying
  // something else throws there. The Burrow treats it exactly as a mismatch —
  // the alternative is an unhandled rejection in the sidecar process.
  const binding = pairingBinding({ handshakeHash: 'not base64url!!' });
  const proof = {
    binding,
    relayNonce: randomSecret(),
    accountId: ACCOUNT,
    passkeyCredentialId: authenticator.credentialId,
    passkeyPublicKey: authenticator.publicKey,
    assertion: await authenticator.assert({ challenge: digest('xx'), origin: ORIGIN, rpId: RP_ID }),
  };
  assert.deepEqual(await verifyPresenceProof(proof, binding, POLICY), {
    ok: false,
    reason: 'challenge-underivable',
  });
  // Same for a nonce that is not base64url: it is decoded into the hash too,
  // and on the Burrow's recompute path it arrives from the Client.
  const bad = { ...(await proofFor(pairingBinding())), relayNonce: 'nonce!!' };
  assert.deepEqual(await verifyPresenceProof(bad, pairingBinding(), POLICY), {
    ok: false,
    reason: 'challenge-underivable',
  });
});

test('every way an assertion can fail collapses to assertion-invalid', async () => {
  // The reasons `verifyPasskeyAssertion` distinguishes are owner-local detail;
  // the ceremony returns one code, because a Client learning *which* check it
  // failed is a probing oracle.
  const binding = pairingBinding();
  const foreignKey = await SimAuthenticator.foreignSigningKey();
  const other = await SimAuthenticator.create({ rpId: RP_ID });
  for (const [why, tamper, overrides] of [
    ['a challenge from another ceremony', { assertion: { challenge: digest('ch9') } }, {}],
    ['a registration, not an authentication', { assertion: { type: 'webauthn.create' } }, {}],
    ['another origin', { assertion: { origin: 'https://evil.example' } }, {}],
    ['another relying party', { assertion: { rpId: 'evil.example' } }, {}],
    ['no user presence', { assertion: { userPresent: false } }, {}],
    ['no user verification', { assertion: { userVerified: false } }, {}],
    ['a signature from another key', { assertion: { signWith: foreignKey } }, {}],
    ['a public key that is not the signer', {}, { passkeyPublicKey: other.publicKey }],
    ['a public key that does not import', {}, { passkeyPublicKey: 'AAAA' }],
  ]) {
    const proof = await proofFor(binding, { tamper: { ...tamper, proof: overrides } });
    assert.deepEqual(await verifyPresenceProof(proof, binding, POLICY), {
      ok: false,
      reason: 'assertion-invalid',
    }, why);
  }
});

test('the verifier never throws, whatever the decrypted payload turns out to be', async () => {
  // Its input is attacker-supplied plaintext from inside a Noise session, and a
  // rejection in the Node Burrow must be an ordinary denial rather than an
  // unhandled async failure that can take the sidecar down.
  const binding = pairingBinding();
  for (const garbage of [
    undefined,
    null,
    0,
    '',
    [],
    { binding: null },
    { binding, relayNonce: {}, assertion: [] },
    { binding, relayNonce: '', accountId: '', passkeyCredentialId: '', passkeyPublicKey: '', assertion: {} },
    Object.create(null),
    new Map(),
  ]) {
    const result = await verifyPresenceProof(garbage, binding, POLICY);
    assert.equal(result.ok, false, JSON.stringify(garbage));
    assert.equal(typeof result.reason, 'string');
  }
});

test('isPresenceProofV1 bounds every field rather than merely typing it', async () => {
  const proof = await proofFor(pairingBinding());
  assert.equal(isPresenceProofV1(proof), true);
  assert.equal(isPresenceProofV1({ ...proof, passkeyPublicKey: 'a'.repeat(CEREMONY_FIELD_LIMIT) }), true);
  assert.equal(isPresenceProofV1({ ...proof, passkeyPublicKey: 'a'.repeat(CEREMONY_FIELD_LIMIT + 1) }), false);
  assert.equal(isPresenceProofV1(null), false);
});

// --- The two-digit confirmation code --------------------------------------

test('every sampled pairing code is two digits, and the space is covered', async () => {
  // Rejection sampling rather than `% 100`: a modulo would make a fifth of the
  // code space over twice as likely as the rest, and 100 is small enough that
  // the bias is worth removing.
  const seen = new Set();
  for (let i = 0; i < 4000; i++) {
    const code = samplePairingCode();
    assert.match(code, /^[0-9]{2}$/);
    assert.equal(code.length, PAIRING_CODE_LENGTH);
    assert.equal(isPairingCode(code), true);
    seen.add(code);
  }
  // With 4000 draws over 100 buckets an empty bucket is astronomically
  // unlikely, so a shortfall here means the sampler is not covering the range.
  assert.ok(seen.size >= 98, `only ${seen.size} distinct codes in 4000 draws`);
  assert.equal(seen.has('00'), true, 'the padded low end must be reachable');
});

test('isPairingCode takes exactly two ASCII digits', () => {
  for (const value of [undefined, null, 42, '', '1', '123', '0x', ' 1', '१२', '९', '-1', '1.']) {
    assert.equal(isPairingCode(value), false, JSON.stringify(value));
  }
  assert.equal(isPairingCode('00'), true);
  assert.equal(isPairingCode('99'), true);
});

// --- The four message guards ----------------------------------------------

test('isPairingRequestV1 wants a code, a bounded label, and a real proof', async () => {
  const presence = await proofFor(pairingBinding());
  const request = { code: '42', label: 'iPhone Safari', presence };
  assert.equal(isPairingRequestV1(request), true);
  // Additive fields are ignored; a bad one is not.
  assert.equal(isPairingRequestV1({ ...request, extra: true }), true);
  for (const [why, value] of [
    ['not an object', 'nope'],
    ['no code', { ...request, code: undefined }],
    ['a three-digit code', { ...request, code: '123' }],
    ['a non-string label', { ...request, label: 42 }],
    ['an over-long label', { ...request, label: 'a'.repeat(CEREMONY_FIELD_LIMIT + 1) }],
    ['no presence', { ...request, presence: undefined }],
    ['a presence that is not one', { ...request, presence: { ...presence, binding: 'x' } }],
  ]) {
    assert.equal(isPairingRequestV1(value), false, why);
  }
});

test('isPairingOutcomeV1 takes the success shape or one of six fixed denials', () => {
  const success = {
    ok: true,
    burrowStaticPublicKey: digest('hs1'),
    burrowLabel: 'Laptop',
    accountId: ACCOUNT,
    passkeyCredentialId: 'cred-1',
    passkeyPublicKeyHash: digest('ph1'),
    deliveryId: digest('del'),
  };
  assert.equal(isPairingOutcomeV1(success), true);
  for (const code of [
    'user-denied',
    'confirmation-mismatch',
    'presence-rejected',
    'invitation-expired',
    'superseded',
    'burrow-error',
  ]) {
    assert.equal(isPairingOutcomeV1({ ok: false, code }), true, code);
  }
  for (const [why, value] of [
    ['not an object', null],
    ['no ok', {}],
    ['a truthy non-true ok', { ...success, ok: 1 }],
    ['a denial code the Client has no copy for', { ok: false, code: 'because-i-said-so' }],
    ['a denial with no code', { ok: false }],
    ['a success missing the delivery id', { ...success, deliveryId: undefined }],
    ['a success with an over-long burrow label', { ...success, burrowLabel: 'a'.repeat(CEREMONY_FIELD_LIMIT + 1) }],
  ]) {
    assert.equal(isPairingOutcomeV1(value), false, why);
  }
});

test('isConnectionRequestV1 is the presence proof and nothing else', async () => {
  const presence = await proofFor(connectionBinding());
  assert.equal(isConnectionRequestV1({ presence }), true);
  assert.equal(isConnectionRequestV1({ presence, extra: 1 }), true);
  assert.equal(isConnectionRequestV1({}), false);
  assert.equal(isConnectionRequestV1(null), false);
  assert.equal(isConnectionRequestV1({ presence: { ...presence, assertion: null } }), false);
});

test('isConnectionOutcomeV1 takes a labelled success or one of five fixed denials', () => {
  assert.equal(isConnectionOutcomeV1({ ok: true, burrowLabel: 'Laptop' }), true);
  assert.equal(isConnectionOutcomeV1({ ok: true, burrowLabel: 'Laptop', directOnly: true }), true);
  for (const code of ['pairing-required', 'presence-rejected', 'protocol-rejected', 'burrow-busy', 'burrow-error']) {
    assert.equal(isConnectionOutcomeV1({ ok: false, code }), true, code);
  }
  for (const [why, value] of [
    ['not an object', 'nope'],
    ['a success with no label', { ok: true }],
    // The one code that must never appear: which half of the ACL conjunction
    // failed is owner-local, so there is no wire spelling for it.
    ['an ACL miss as a denial code', { ok: false, code: 'client-not-paired' }],
    ['a denial code from the other ceremony', { ok: false, code: 'user-denied' }],
    // Present only as `true`: a Client must never read a falsy spelling as one.
    ['a directOnly that is not true', { ok: true, burrowLabel: 'Laptop', directOnly: false }],
    ['a directOnly that is a string', { ok: true, burrowLabel: 'Laptop', directOnly: 'yes' }],
  ]) {
    assert.equal(isConnectionOutcomeV1(value), false, why);
  }
});

// --- One-time connection ---------------------------------------------------

test('isOneTimeRequestV1 wants a code and a bounded label, and no proof', () => {
  const request = { code: '07', label: 'iPhone Safari' };
  assert.equal(isOneTimeRequestV1(request), true);
  assert.equal(isOneTimeRequestV1({ ...request, label: '' }), true);
  assert.equal(isOneTimeRequestV1({ ...request, label: 'a'.repeat(CEREMONY_FIELD_LIMIT) }), true);
  // Additive fields are ignored, as on the other requests.
  assert.equal(isOneTimeRequestV1({ ...request, extra: true }), true);
  for (const [why, value] of [
    ['not an object', 'nope'],
    ['null', null],
    ['no code', { label: request.label }],
    ['a three-digit code', { ...request, code: '123' }],
    ['a numeric code', { ...request, code: 7 }],
    ['no label', { code: request.code }],
    ['a non-string label', { ...request, label: 42 }],
    ['an over-long label', { ...request, label: 'a'.repeat(CEREMONY_FIELD_LIMIT + 1) }],
  ]) {
    assert.equal(isOneTimeRequestV1(value), false, why);
  }
});

test('a one-time label shows only as a member of the closed set', () => {
  assert.deepEqual([...ONE_TIME_DEVICE_LABELS], ['iPhone', 'iPad', 'Android phone', 'Phone browser']);
  assert.equal(Object.isFrozen(ONE_TIME_DEVICE_LABELS), true);
  assert.equal(ONE_TIME_UNKNOWN_DEVICE_LABEL, 'Phone browser');
  for (const label of ONE_TIME_DEVICE_LABELS) assert.equal(knownOneTimeDeviceLabel(label), label);
  // The phone chooses the label and the digits: text that could name digits,
  // a near miss, and a non-string all read as the one fallback.
  for (const label of ['iPhone · code 58', 'iphone', ' iPad', 'iPad\u0000', 'Dormouse Pocket (browser)', '', 42, null]) {
    assert.equal(knownOneTimeDeviceLabel(label), ONE_TIME_UNKNOWN_DEVICE_LABEL, String(label));
  }
});

test('isOneTimeOutcomeV1 takes a labelled success or one of four fixed denials', () => {
  assert.deepEqual(
    [...ONE_TIME_DENIAL_CODES],
    ['user-denied', 'confirmation-mismatch', 'link-expired', 'burrow-error'],
  );
  // Frozen, so no importer can widen what the guard admits.
  assert.equal(Object.isFrozen(ONE_TIME_DENIAL_CODES), true);
  assert.equal(isOneTimeOutcomeV1({ ok: true, burrowLabel: 'Laptop' }), true);
  assert.equal(isOneTimeOutcomeV1({ ok: true, burrowLabel: '' }), true);
  for (const code of ONE_TIME_DENIAL_CODES) {
    assert.equal(isOneTimeOutcomeV1({ ok: false, code }), true, code);
  }
  for (const [why, value] of [
    ['not an object', 'nope'],
    ['no ok', {}],
    ['a truthy non-true ok', { ok: 1, burrowLabel: 'Laptop' }],
    ['a success with no label', { ok: true }],
    ['a success with an over-long label', { ok: true, burrowLabel: 'a'.repeat(CEREMONY_FIELD_LIMIT + 1) }],
    ['a denial with no code', { ok: false }],
    // The other ceremonies' codes have no one-time copy: nothing here is a
    // presence check, an invitation, or an ACL.
    ['a pairing code', { ok: false, code: 'invitation-expired' }],
    ['a presence code', { ok: false, code: 'presence-rejected' }],
    ['an ACL code', { ok: false, code: 'pairing-required' }],
  ]) {
    assert.equal(isOneTimeOutcomeV1(value), false, why);
  }
});

test('isSessionEndV1 is the goodbye in its three exact shapes and nothing else', () => {
  assert.equal(isSessionEndV1(SESSION_END_V1), true);
  assert.equal(isSessionEndV1({ v: 1, t: 'session-end' }), true);
  assert.equal(isSessionEndV1({ v: 1, t: 'session-end', reason: 'network-not-allowed' }), true);
  for (const [address, addressSource] of [
    ['172.58.12.9', 'observed'],
    ['2607:fb90:1:2::9', 'reported'],
    ['::ffff:192.168.1.20', 'observed'],
    ['ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255', 'reported'],
  ]) {
    assert.equal(
      isSessionEndV1({ v: 1, t: 'session-end', reason: 'network-not-allowed', address, addressSource }),
      true,
      address,
    );
  }
  // Frozen, so no sender can grow the shared value into a shape the guard refuses.
  assert.equal(Object.isFrozen(SESSION_END_V1), true);
  const refused = { v: 1, t: 'session-end', reason: 'network-not-allowed' };
  for (const [why, value] of [
    ['not an object', 'session-end'],
    ['null', null],
    ['an array', [{ v: 1, t: 'session-end' }]],
    ['a future version', { v: 2, t: 'session-end' }],
    ['no version', { t: 'session-end' }],
    // A reason no reader has is the shape a smuggler would pick.
    ['another reason', { v: 1, t: 'session-end', reason: 'take-back' }],
    ['an extra key', { ...refused, note: 'hi' }],
    ['an address with no source', { ...refused, address: '172.58.12.9' }],
    ['a source with no address', { ...refused, addressSource: 'observed' }],
    ['an address with no reason', { v: 1, t: 'session-end', address: '1.2.3.4', addressSource: 'observed', x: 1 }],
    ['an unknown source', { ...refused, address: '172.58.12.9', addressSource: 'guessed' }],
    ['a hostname', { ...refused, address: 'phone.local', addressSource: 'observed' }],
    ['an mDNS name', { ...refused, address: '0b1c5f3a-1d2e-4c1b-9a1e-1234567890ab.local', addressSource: 'observed' }],
    ['a zoned address', { ...refused, address: 'fe80::1%en0', addressSource: 'observed' }],
    ['an address with a port', { ...refused, address: '172.58.12.9:443', addressSource: 'observed' }],
    ['markup', { ...refused, address: '<b>1.2.3.4</b>', addressSource: 'observed' }],
    ['a direct-path signal', { v: 1, t: 'direct-switch' }],
    ['a ceremony outcome', { ok: true, burrowLabel: 'Laptop' }],
  ]) {
    assert.equal(isSessionEndV1(value), false, why);
  }
});

// --- Fixed-size outcomes ---------------------------------------------------

/** One established session pair, so control messages are measured on the wire. */
async function established() {
  const prologue = e2eConnectionPrologue(routingId('burrow'), routingId('conn'));
  const burrowStatic = await generateNoiseKeyPair();
  const initiator = await createNoiseInitiator({
    prologue,
    staticKeyPair: await generateNoiseKeyPair(),
    remoteStaticPublicKey: burrowStatic.publicKey,
  });
  const responder = await createNoiseResponder({ prologue, staticKeyPair: burrowStatic });
  await responder.readMessage(await initiator.writeMessage());
  await initiator.readMessage(await responder.writeMessage());
  return new NoiseTransportSession(responder.session);
}

test('a pairing approval and every pairing denial are the same size on the wire', async () => {
  // The relay sees the ciphertext and nothing else, so an approval that was
  // longer than a denial would leak the decision by length alone.
  const burrow = await established();
  const success = burrow.sendControl({
    ok: true,
    burrowStaticPublicKey: toBase64Url(new Uint8Array(32)),
    burrowLabel: "Ned's MacBook Pro (16-inch, 2025)",
    accountId: ACCOUNT,
    passkeyCredentialId: randomRoutingId(),
    passkeyPublicKeyHash: digest('ph1'),
    deliveryId: randomSecret(),
  });
  for (const code of [
    'user-denied',
    'confirmation-mismatch',
    'presence-rejected',
    'invitation-expired',
    'superseded',
    'burrow-error',
  ]) {
    assert.equal(burrow.sendControl({ ok: false, code }).length, success.length, code);
  }
});

test('a connection success and every connection denial are the same size on the wire', async () => {
  const burrow = await established();
  const success = burrow.sendControl({ ok: true, burrowLabel: "Ned's MacBook Pro (16-inch, 2025)" });
  for (const code of ['pairing-required', 'presence-rejected', 'protocol-rejected', 'burrow-busy', 'burrow-error']) {
    assert.equal(burrow.sendControl({ ok: false, code }).length, success.length, code);
  }
  // And the two ceremonies' outcomes are indistinguishable from each other too:
  // every control message pads to the same size, whatever it says.
  const pairing = burrow.sendControl({ ok: false, code: 'user-denied' });
  assert.equal(pairing.length, success.length);
});

test('a one-time success and every one-time denial are the same size on the wire', async () => {
  const burrow = await established();
  const success = burrow.sendControl({ ok: true, burrowLabel: "Ned's MacBook Pro (16-inch, 2025)" });
  for (const code of ONE_TIME_DENIAL_CODES) {
    assert.equal(burrow.sendControl({ ok: false, code }).length, success.length, code);
  }
  // And the phone's request is the same size as any other control message.
  assert.equal(burrow.sendControl({ code: '42', label: 'iPhone Safari' }).length, success.length);
});

test('the goodbye is the same size on the wire as every other control message', async () => {
  const burrow = await established();
  const outcome = burrow.sendControl({ ok: true, burrowLabel: "Ned's MacBook Pro (16-inch, 2025)" });
  assert.equal(burrow.sendControl({ ...SESSION_END_V1 }).length, outcome.length);
  const longest = 'ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255';
  const refused = { ...SESSION_END_V1, reason: 'network-not-allowed', address: longest, addressSource: 'reported' };
  assert.equal(burrow.sendControl(refused).length, outcome.length);
});
