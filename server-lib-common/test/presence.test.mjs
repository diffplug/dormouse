/**
 * The derived WebAuthn presence challenge
 * (docs/specs/remote-security-model.md -> E2E identities and presence).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { PRESENCE_DOMAIN, isPresenceBinding, presenceChallenge } from '../dist/index.js';

const HANDSHAKE_HASH = Buffer.alloc(32, 0x11).toString('base64url');
const HOST_CHALLENGE = Buffer.alloc(32, 0x22).toString('base64url');
const CONNECTION_ID = Buffer.alloc(16, 0x33).toString('base64url');
const SERVER_NONCE = Buffer.alloc(32, 0x44).toString('base64url');

const PAIRING = {
  kind: 'pairing',
  hostId: 'host-1',
  handshakeHash: HANDSHAKE_HASH,
  passkeyCredentialId: 'cred-1',
};

const CONNECTION = {
  kind: 'connection',
  hostId: 'host-1',
  connectionId: CONNECTION_ID,
  hostChallenge: HOST_CHALLENGE,
  handshakeHash: HANDSHAKE_HASH,
  passkeyCredentialId: 'cred-1',
};

/**
 * The expected bytes, built here from `node:crypto` and `Buffer` alone — no
 * helper this package ships. The point of a vector is that it fails when the
 * production encoding changes, which it cannot do if it is computed by the
 * production encoder.
 */
function expectedChallenge(parts) {
  const framed = [];
  for (const part of parts) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(part.length);
    framed.push(length, part);
  }
  return createHash('sha256').update(Buffer.concat(framed)).digest().toString('base64url');
}

const utf8 = (text) => Buffer.from(text, 'utf8');
const b64u = (text) => Buffer.from(text, 'base64url');

test('the pairing challenge is the documented bytes', async () => {
  // Base64url fields as the bytes they encode; everything else as UTF-8.
  const expected = expectedChallenge([
    utf8(PRESENCE_DOMAIN),
    utf8('pairing'),
    utf8('host-1'),
    b64u(HANDSHAKE_HASH),
    utf8('cred-1'),
    b64u(SERVER_NONCE),
  ]);
  assert.equal(await presenceChallenge(PAIRING, SERVER_NONCE), expected);
  assert.match(expected, /^[A-Za-z0-9_-]{43}$/);
});

test('the connection challenge is the documented bytes, in declared order', async () => {
  const expected = expectedChallenge([
    utf8(PRESENCE_DOMAIN),
    utf8('connection'),
    utf8('host-1'),
    b64u(CONNECTION_ID),
    b64u(HOST_CHALLENGE),
    b64u(HANDSHAKE_HASH),
    utf8('cred-1'),
    b64u(SERVER_NONCE),
  ]);
  assert.equal(await presenceChallenge(CONNECTION, SERVER_NONCE), expected);
});

test('the two kinds never collide', async () => {
  // A pairing proof presented at connect time must not verify, which starts
  // with the kind being part of the hashed statement.
  assert.notEqual(
    await presenceChallenge(PAIRING, SERVER_NONCE),
    await presenceChallenge(CONNECTION, SERVER_NONCE),
  );
});

test('every field and the nonce change the challenge', async () => {
  const base = await presenceChallenge(CONNECTION, SERVER_NONCE);
  const other = Buffer.alloc(32, 0x55).toString('base64url');
  for (const change of [
    { hostId: 'host-2' },
    { connectionId: Buffer.alloc(16, 0x66).toString('base64url') },
    { hostChallenge: other },
    { handshakeHash: other },
    { passkeyCredentialId: 'cred-2' },
  ]) {
    assert.notEqual(await presenceChallenge({ ...CONNECTION, ...change }, SERVER_NONCE), base);
  }
  assert.notEqual(await presenceChallenge(CONNECTION, other), base);
});

test('the fields cannot be slid past each other', async () => {
  // `lengthPrefixedConcat` puts the boundaries in the hash: without it,
  // moving a character between two adjacent text fields would collide.
  assert.notEqual(
    await presenceChallenge(PAIRING, SERVER_NONCE),
    await presenceChallenge(
      { ...PAIRING, hostId: 'host-', passkeyCredentialId: '1cred-1' },
      SERVER_NONCE,
    ),
  );
});

test('the domain is separate from every other signed statement', () => {
  assert.equal(PRESENCE_DOMAIN, 'dormouse/presence/v1');
});

test('the guard takes both kinds and refuses everything else', () => {
  assert.equal(isPresenceBinding(PAIRING), true);
  assert.equal(isPresenceBinding(CONNECTION), true);
  // A connection binding missing the values that make it one.
  assert.equal(isPresenceBinding({ ...CONNECTION, hostChallenge: undefined }), false);
  assert.equal(isPresenceBinding({ ...CONNECTION, connectionId: 7 }), false);
  assert.equal(isPresenceBinding({ ...PAIRING, kind: 'other' }), false);
  assert.equal(isPresenceBinding({ ...PAIRING, handshakeHash: undefined }), false);
  assert.equal(isPresenceBinding(null), false);
  assert.equal(isPresenceBinding('pairing'), false);
});

test('the guard takes exactly one kind\'s fields, never an extra one', () => {
  // Only what `presenceChallenge` hashes is covered by the assertion, so a
  // field it does not hash must not ride along inside a verified binding.
  assert.equal(isPresenceBinding({ ...PAIRING, connectionId: CONNECTION_ID }), false);
  assert.equal(isPresenceBinding({ ...PAIRING, hostChallenge: HOST_CHALLENGE }), false);
  assert.equal(isPresenceBinding({ ...PAIRING, note: 'anything' }), false);
  assert.equal(isPresenceBinding({ ...CONNECTION, note: 'anything' }), false);
  // A connection binding is not a pairing binding wearing the other tag.
  assert.equal(isPresenceBinding({ ...CONNECTION, kind: 'pairing' }), false);
});

test('the guard bounds every field, because a megabyte string is a string', () => {
  assert.equal(isPresenceBinding({ ...PAIRING, hostId: 'h'.repeat(1024) }), true);
  assert.equal(isPresenceBinding({ ...PAIRING, hostId: 'h'.repeat(1025) }), false);
  assert.equal(isPresenceBinding({ ...CONNECTION, hostChallenge: 'c'.repeat(1025) }), false);
});

test('the nonce is bounded too, since no binding guard covers it', async () => {
  // On the Host's recompute path the nonce arrives from the Client, and
  // `isPresenceBinding` never sees it.
  // Well-formed base64url on both sides of the limit, so only the bound can
  // be what rejects: 1028 characters decode cleanly, 1024 is the last allowed.
  await assert.rejects(presenceChallenge(PAIRING, 'A'.repeat(1028)));
  await assert.rejects(presenceChallenge(PAIRING, undefined));
  assert.equal(typeof (await presenceChallenge(PAIRING, 'A'.repeat(1024))), 'string');
});

test('a field that is not base64url throws rather than hashing garbage', async () => {
  // The guard runs first and a throw is a failed presence check, not a
  // silently different challenge.
  await assert.rejects(presenceChallenge({ ...PAIRING, handshakeHash: 'not base64url!' }, SERVER_NONCE));
  await assert.rejects(presenceChallenge(PAIRING, 'not base64url!'));
});
