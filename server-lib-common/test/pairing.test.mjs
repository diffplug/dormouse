import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PAIRING_TTL_MS,
  HostAcl,
  PAIRING_FINGERPRINT_LENGTH,
  PairingCeremony,
  PairingError,
  boundedPairingAccount,
  boundedPairingLabel,
  isPairingRequest,
  pairingFingerprint,
} from '../dist/index.js';
import { FakeClock } from './harness/actors.mjs';

const REQUEST = {
  accountId: 'account-1',
  passkeyCredentialId: 'cred-1',
  passkeyPublicKeyHash: 'hash-1',
  devicePublicKey: 'device-1',
  requestedLabel: 'iPhone Safari',
};

function makeCeremony(options = {}) {
  const clock = new FakeClock();
  const acl = new HostAcl('host-1', { now: clock.now });
  const ceremony = new PairingCeremony(acl, { now: clock.now, ...options });
  return { clock, acl, ceremony };
}

function assertPairingError(fn, code) {
  assert.throws(fn, (error) => error instanceof PairingError && error.code === code);
}

test('begin creates a pending ticket with a unique id', () => {
  const { clock, ceremony } = makeCeremony();
  const a = ceremony.begin(REQUEST);
  const b = ceremony.begin(REQUEST);
  assert.notEqual(a.pairingId, b.pairingId);
  assert.equal(a.state, 'pending');
  assert.deepEqual(a.request, REQUEST);
  assert.equal(a.requestedAt, clock.now());
  assert.equal(a.expiresAt, clock.now() + DEFAULT_PAIRING_TTL_MS);
});

test('begin does not touch the ACL — only approve does', () => {
  const { acl, ceremony } = makeCeremony();
  ceremony.begin(REQUEST);
  assert.equal(acl.records().length, 0);
});

test('approve writes the ACL record with approver metadata', () => {
  const { clock, acl, ceremony } = makeCeremony();
  const ticket = ceremony.begin(REQUEST);
  const record = ceremony.approve(ticket.pairingId, { approvedBy: 'ned@host' });
  assert.deepEqual(record, {
    hostId: 'host-1',
    accountId: 'account-1',
    passkeyCredentialId: 'cred-1',
    passkeyPublicKeyHash: 'hash-1',
    devicePublicKey: 'device-1',
    approvedAt: clock.now(),
    approvedBy: 'ned@host',
    label: 'iPhone Safari',
    revokedAt: null,
  });
  assert.deepEqual(acl.records(), [record]);
  assert.equal(ceremony.get(ticket.pairingId).state, 'approved');
});

test('the approver can override the requested label', () => {
  const { ceremony } = makeCeremony();
  const ticket = ceremony.begin(REQUEST);
  const record = ceremony.approve(ticket.pairingId, { approvedBy: 'ned', label: 'Ned iPhone' });
  assert.equal(record.label, 'Ned iPhone');
});

test('deny leaves the ACL untouched', () => {
  const { acl, ceremony } = makeCeremony();
  const ticket = ceremony.begin(REQUEST);
  ceremony.deny(ticket.pairingId);
  assert.equal(acl.records().length, 0);
  assert.equal(ceremony.get(ticket.pairingId).state, 'denied');
});

test('approve after deny fails', () => {
  const { ceremony } = makeCeremony();
  const ticket = ceremony.begin(REQUEST);
  ceremony.deny(ticket.pairingId);
  assertPairingError(() => ceremony.approve(ticket.pairingId, { approvedBy: 'ned' }), 'not-pending');
});

test('double approve fails', () => {
  const { acl, ceremony } = makeCeremony();
  const ticket = ceremony.begin(REQUEST);
  ceremony.approve(ticket.pairingId, { approvedBy: 'ned' });
  assertPairingError(() => ceremony.approve(ticket.pairingId, { approvedBy: 'ned' }), 'not-pending');
  assert.equal(acl.records().length, 1);
});

test('an expired pairing cannot be approved or denied', () => {
  const { clock, acl, ceremony } = makeCeremony({ ttlMs: 1000 });
  const ticket = ceremony.begin(REQUEST);
  clock.advance(1000);
  assert.equal(ceremony.get(ticket.pairingId).state, 'expired');
  assertPairingError(() => ceremony.approve(ticket.pairingId, { approvedBy: 'ned' }), 'expired');
  assertPairingError(() => ceremony.deny(ticket.pairingId), 'expired');
  assert.equal(acl.records().length, 0);
});

test('a pairing approved just before expiry succeeds', () => {
  const { clock, ceremony } = makeCeremony({ ttlMs: 1000 });
  const ticket = ceremony.begin(REQUEST);
  clock.advance(999);
  const record = ceremony.approve(ticket.pairingId, { approvedBy: 'ned' });
  assert.equal(record.devicePublicKey, 'device-1');
});

test('unknown pairing ids are rejected', () => {
  const { ceremony } = makeCeremony();
  assertPairingError(() => ceremony.approve('nope', { approvedBy: 'ned' }), 'unknown-pairing');
  assertPairingError(() => ceremony.deny('nope'), 'unknown-pairing');
  assert.equal(ceremony.get('nope'), undefined);
});

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

test('boundedPairingLabel and boundedPairingAccount strip bidi and cap length', () => {
  const hostile = `‮owner${'A'.repeat(500)}`;
  for (const bounded of [boundedPairingLabel(hostile), boundedPairingAccount(hostile)]) {
    assert.equal(bounded.includes('‮'), false);
    assert.ok(Array.from(bounded).length <= 64);
  }
  assert.equal(boundedPairingLabel(undefined), '(unnamed)');
  assert.equal(boundedPairingAccount(undefined), '(unknown)');
});

test('the fingerprint skips the constant prefix of a raw P-256 point', async () => {
  // base64url of an uncompressed point always starts `B` (the 0x04 tag), and
  // its second character only ever takes 16 values. Slicing from zero would
  // spend two of eight displayed characters on ~4 bits.
  const { webcrypto } = await import('node:crypto');
  const pair = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const raw = Buffer.from(await webcrypto.subtle.exportKey('raw', pair.publicKey));
  const devicePublicKey = raw.toString('base64url');

  assert.equal(devicePublicKey[0], 'B');
  const fingerprint = pairingFingerprint(devicePublicKey);
  assert.equal(fingerprint.length, PAIRING_FINGERPRINT_LENGTH);
  assert.equal(fingerprint, devicePublicKey.slice(2, 2 + PAIRING_FINGERPRINT_LENGTH));
});

test('the ticket map is bounded by count, not only by age', () => {
  // Age alone is rate-bounded: a relay sending faster than the TTL still grows
  // the map for a whole grace window.
  const { ceremony } = makeCeremony();
  const tickets = [];
  for (let i = 0; i < 500; i++) tickets.push(ceremony.begin(REQUEST));

  // The newest is still live; something far enough back has been evicted.
  assert.ok(ceremony.get(tickets[tickets.length - 1].pairingId));
  assert.equal(ceremony.get(tickets[0].pairingId), undefined);
});
