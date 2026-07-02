import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PAIRING_TTL_MS, HostAcl, PairingCeremony, PairingError } from '../dist/index.js';
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
