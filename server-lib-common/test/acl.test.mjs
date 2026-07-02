import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HostAcl } from '../dist/index.js';
import { FakeClock } from './harness/actors.mjs';

const CLIENT = {
  accountId: 'account-1',
  passkeyCredentialId: 'cred-1',
  passkeyPublicKeyHash: 'hash-1',
  devicePublicKey: 'device-1',
  approvedBy: 'host-user',
  label: 'iPhone Safari',
};

function makeAcl() {
  const clock = new FakeClock();
  return { clock, acl: new HostAcl('host-1', { now: clock.now }) };
}

test('approve stores the full record', () => {
  const { clock, acl } = makeAcl();
  const record = acl.approve(CLIENT);
  assert.deepEqual(record, {
    ...CLIENT,
    hostId: 'host-1',
    approvedAt: clock.now(),
    revokedAt: null,
  });
  assert.deepEqual(acl.records(), [record]);
});

test('findActive requires passkey AND device key on the same record', () => {
  const { acl } = makeAcl();
  acl.approve(CLIENT);
  acl.approve({ ...CLIENT, passkeyCredentialId: 'cred-2', devicePublicKey: 'device-2' });
  assert.ok(acl.findActive({ passkeyCredentialId: 'cred-1', devicePublicKey: 'device-1' }));
  assert.ok(acl.findActive({ passkeyCredentialId: 'cred-2', devicePublicKey: 'device-2' }));
  // Each half exists on some record, but never together.
  assert.equal(acl.findActive({ passkeyCredentialId: 'cred-1', devicePublicKey: 'device-2' }), undefined);
  assert.equal(acl.findActive({ passkeyCredentialId: 'cred-2', devicePublicKey: 'device-1' }), undefined);
});

test('hasActivePasskey / hasActiveDevice track each half individually', () => {
  const { acl } = makeAcl();
  acl.approve(CLIENT);
  assert.equal(acl.hasActivePasskey('cred-1'), true);
  assert.equal(acl.hasActivePasskey('cred-2'), false);
  assert.equal(acl.hasActiveDevice('device-1'), true);
  assert.equal(acl.hasActiveDevice('device-2'), false);
});

test('revokeDevice revokes every active record for that device', () => {
  const { clock, acl } = makeAcl();
  acl.approve(CLIENT);
  acl.approve({ ...CLIENT, passkeyCredentialId: 'cred-2' }); // same device, second passkey
  acl.approve({ ...CLIENT, devicePublicKey: 'device-2' });
  clock.advance(1000);
  assert.equal(acl.revokeDevice('device-1'), 2);
  assert.equal(acl.hasActiveDevice('device-1'), false);
  assert.equal(acl.hasActiveDevice('device-2'), true);
  const revoked = acl.records().filter((record) => record.revokedAt !== null);
  assert.equal(revoked.length, 2);
  for (const record of revoked) assert.equal(record.revokedAt, clock.now());
});

test('revokePasskey revokes every active record for that credential', () => {
  const { acl } = makeAcl();
  acl.approve(CLIENT);
  acl.approve({ ...CLIENT, devicePublicKey: 'device-2' });
  acl.approve({ ...CLIENT, passkeyCredentialId: 'cred-2' });
  assert.equal(acl.revokePasskey('cred-1'), 2);
  assert.equal(acl.hasActivePasskey('cred-1'), false);
  assert.equal(acl.hasActivePasskey('cred-2'), true);
});

test('revoked records no longer authorize', () => {
  const { acl } = makeAcl();
  acl.approve(CLIENT);
  acl.revokeDevice('device-1');
  assert.equal(acl.findActive({ passkeyCredentialId: 'cred-1', devicePublicKey: 'device-1' }), undefined);
  assert.equal(acl.revokeDevice('device-1'), 0, 'already-revoked records are not re-revoked');
});

test('re-approving the same pair supersedes the old record', () => {
  const { clock, acl } = makeAcl();
  acl.approve(CLIENT);
  clock.advance(5000);
  const fresh = acl.approve({ ...CLIENT, label: 'iPhone Safari (repaired)' });
  const active = acl.activeRecords();
  assert.equal(active.length, 1);
  assert.deepEqual(active[0], fresh);
  const all = acl.records();
  assert.equal(all.length, 2);
  assert.equal(all[0].revokedAt, clock.now());
});

test('records round-trip through fromRecords (persistence)', () => {
  const { clock, acl } = makeAcl();
  acl.approve(CLIENT);
  clock.advance(1000);
  acl.approve({ ...CLIENT, devicePublicKey: 'device-2' });
  acl.revokeDevice('device-1');
  const restored = HostAcl.fromRecords('host-1', acl.records(), { now: clock.now });
  assert.deepEqual(restored.records(), acl.records());
  assert.equal(restored.hasActiveDevice('device-1'), false);
  assert.equal(restored.hasActiveDevice('device-2'), true);
});

test('fromRecords refuses records from another host', () => {
  const { acl } = makeAcl();
  acl.approve(CLIENT);
  assert.throws(() => HostAcl.fromRecords('host-2', acl.records()), /cannot be loaded/);
});

test('returned records are copies — mutating them cannot alter the ACL', () => {
  const { acl } = makeAcl();
  acl.approve(CLIENT);
  acl.records()[0].revokedAt = 123;
  acl.findActive({ passkeyCredentialId: 'cred-1', devicePublicKey: 'device-1' }).revokedAt = 123;
  assert.equal(acl.activeRecords().length, 1);
});
