import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CLIENT_STATIC_PUBLIC_KEY_LENGTH,
  DELIVERY_ID_LENGTH,
  HostAcl,
  isHostAclRecord,
} from '../dist/index.js';
import { FakeClock } from './harness/actors.mjs';

/** A readable stand-in for a 43-character base64url Client static. */
const clientStatic = (tag) => tag.padEnd(CLIENT_STATIC_PUBLIC_KEY_LENGTH, 'A');
/** Same, for a delivery id; both are base64url of 32 bytes. */
const delivery = (tag) => tag.padEnd(DELIVERY_ID_LENGTH, 'D');

const CLIENT_1 = clientStatic('cs1');
const CLIENT_2 = clientStatic('cs2');

const CLIENT = {
  accountId: 'account-1',
  passkeyCredentialId: 'cred-1',
  passkeyPublicKeyHash: 'hash-1',
  clientStaticPublicKey: CLIENT_1,
  deliveryId: delivery('del1'),
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
  // What approve writes must be what a store can read back.
  assert.equal(isHostAclRecord(record), true);
});

test('findActive requires passkey AND Client static on the same record', () => {
  const { acl } = makeAcl();
  acl.approve(CLIENT);
  acl.approve({ ...CLIENT, passkeyCredentialId: 'cred-2', clientStaticPublicKey: CLIENT_2 });
  assert.ok(acl.findActive({ passkeyCredentialId: 'cred-1', clientStaticPublicKey: CLIENT_1 }));
  assert.ok(acl.findActive({ passkeyCredentialId: 'cred-2', clientStaticPublicKey: CLIENT_2 }));
  // Each half exists on some record, but never together.
  assert.equal(
    acl.findActive({ passkeyCredentialId: 'cred-1', clientStaticPublicKey: CLIENT_2 }),
    undefined,
  );
  assert.equal(
    acl.findActive({ passkeyCredentialId: 'cred-2', clientStaticPublicKey: CLIENT_1 }),
    undefined,
  );
});

test('authorize returns the record when both halves match', () => {
  const { acl } = makeAcl();
  const record = acl.approve(CLIENT);
  const auth = acl.authorize({ passkeyCredentialId: 'cred-1', clientStaticPublicKey: CLIENT_1 });
  assert.deepEqual(auth, { record });
});

test('authorize explains a miss by which half is unpaired', () => {
  const { acl } = makeAcl();
  acl.approve(CLIENT);
  assert.deepEqual(acl.authorize({ passkeyCredentialId: 'cred-2', clientStaticPublicKey: CLIENT_1 }), {
    record: null,
    reasons: ['passkey-not-paired'],
  });
  assert.deepEqual(acl.authorize({ passkeyCredentialId: 'cred-1', clientStaticPublicKey: CLIENT_2 }), {
    record: null,
    reasons: ['client-not-paired'],
  });
  assert.deepEqual(acl.authorize({ passkeyCredentialId: 'cred-2', clientStaticPublicKey: CLIENT_2 }), {
    record: null,
    reasons: ['passkey-not-paired', 'client-not-paired'],
  });
});

test('authorize reports a pairing mismatch when both halves are paired separately', () => {
  const { acl } = makeAcl();
  acl.approve(CLIENT);
  acl.approve({ ...CLIENT, passkeyCredentialId: 'cred-2', clientStaticPublicKey: CLIENT_2 });
  assert.deepEqual(acl.authorize({ passkeyCredentialId: 'cred-1', clientStaticPublicKey: CLIENT_2 }), {
    record: null,
    reasons: ['pairing-mismatch'],
  });
});

test('authorize does not match revoked records', () => {
  const { acl } = makeAcl();
  acl.approve(CLIENT);
  acl.revokeClient(CLIENT_1);
  const auth = acl.authorize({ passkeyCredentialId: 'cred-1', clientStaticPublicKey: CLIENT_1 });
  assert.equal(auth.record, null);
  assert.deepEqual(auth.reasons, ['passkey-not-paired', 'client-not-paired']);
});

test('hasActivePasskey / hasActiveClient track each half individually', () => {
  const { acl } = makeAcl();
  acl.approve(CLIENT);
  assert.equal(acl.hasActivePasskey('cred-1'), true);
  assert.equal(acl.hasActivePasskey('cred-2'), false);
  assert.equal(acl.hasActiveClient(CLIENT_1), true);
  assert.equal(acl.hasActiveClient(CLIENT_2), false);
});

test('revokeClient revokes every active record for that Client static', () => {
  const { clock, acl } = makeAcl();
  acl.approve(CLIENT);
  acl.approve({ ...CLIENT, passkeyCredentialId: 'cred-2' }); // same Client, second passkey
  acl.approve({ ...CLIENT, clientStaticPublicKey: CLIENT_2 });
  clock.advance(1000);
  assert.equal(acl.revokeClient(CLIENT_1), 2);
  assert.equal(acl.hasActiveClient(CLIENT_1), false);
  assert.equal(acl.hasActiveClient(CLIENT_2), true);
  const revoked = acl.records().filter((record) => record.revokedAt !== null);
  assert.equal(revoked.length, 2);
  for (const record of revoked) assert.equal(record.revokedAt, clock.now());
});

test('revokePasskey revokes every active record for that credential', () => {
  const { acl } = makeAcl();
  acl.approve(CLIENT);
  acl.approve({ ...CLIENT, clientStaticPublicKey: CLIENT_2 });
  acl.approve({ ...CLIENT, passkeyCredentialId: 'cred-2' });
  assert.equal(acl.revokePasskey('cred-1'), 2);
  assert.equal(acl.hasActivePasskey('cred-1'), false);
  assert.equal(acl.hasActivePasskey('cred-2'), true);
});

test('revoked records no longer authorize', () => {
  const { acl } = makeAcl();
  acl.approve(CLIENT);
  acl.revokeClient(CLIENT_1);
  assert.equal(
    acl.findActive({ passkeyCredentialId: 'cred-1', clientStaticPublicKey: CLIENT_1 }),
    undefined,
  );
  assert.equal(acl.revokeClient(CLIENT_1), 0, 'already-revoked records are not re-revoked');
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

test('re-pairing mints a new delivery id without disturbing the old rows', () => {
  // The delivery id is the bearer capability the Client presents to the Relay
  // for its push rows, so a superseding approval must not reuse the one the
  // revoked record carried.
  const { acl } = makeAcl();
  acl.approve(CLIENT);
  const fresh = acl.approve({ ...CLIENT, deliveryId: delivery('del2') });
  assert.notEqual(fresh.deliveryId, CLIENT.deliveryId);
  assert.equal(acl.records()[0].deliveryId, CLIENT.deliveryId);
});

test('records round-trip through fromRecords (persistence)', () => {
  const { clock, acl } = makeAcl();
  acl.approve(CLIENT);
  clock.advance(1000);
  acl.approve({ ...CLIENT, clientStaticPublicKey: CLIENT_2 });
  acl.revokeClient(CLIENT_1);
  const restored = HostAcl.fromRecords('host-1', acl.records(), { now: clock.now });
  assert.deepEqual(restored.records(), acl.records());
  assert.equal(restored.hasActiveClient(CLIENT_1), false);
  assert.equal(restored.hasActiveClient(CLIENT_2), true);
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
  acl.findActive({ passkeyCredentialId: 'cred-1', clientStaticPublicKey: CLIENT_1 }).revokedAt = 123;
  assert.equal(acl.activeRecords().length, 1);
});

// --- isHostAclRecord: the whole of the Host-ACL version --------------------

const STORED = {
  hostId: 'host-1',
  accountId: 'account-1',
  passkeyCredentialId: 'cred-1',
  passkeyPublicKeyHash: 'hash-1',
  clientStaticPublicKey: CLIENT_1,
  deliveryId: delivery('del1'),
  approvedAt: 1,
  approvedBy: 'host-user',
  label: 'iPhone Safari',
  revokedAt: null,
};

test('isHostAclRecord accepts a stored v2 row, revoked or not', () => {
  assert.equal(isHostAclRecord(STORED), true);
  assert.equal(isHostAclRecord({ ...STORED, revokedAt: 2 }), true);
});

test('isHostAclRecord drops a record written before the E2E cutover', () => {
  // The reset-and-re-pair the scope requires, with no migration reader
  // anywhere: a legacy row carries a `devicePublicKey` and neither E2E field,
  // so it fails here and is dropped on read rather than reaching the
  // authorization conjunction with two undefined halves.
  const legacy = { ...STORED, devicePublicKey: 'BLegacyDeviceKey' };
  delete legacy.clientStaticPublicKey;
  delete legacy.deliveryId;
  assert.equal(isHostAclRecord(legacy), false);
  // A row that kept the device key *and* gained the new fields is still a
  // valid record — the extra key is inert, and refusing it would be a
  // migration reader by another name.
  assert.equal(isHostAclRecord({ ...STORED, devicePublicKey: 'BLegacyDeviceKey' }), true);
});

test('isHostAclRecord requires both E2E fields at their exact length', () => {
  // Exact, not bounded: both are base64url of 32 bytes, and a record whose
  // halves are the wrong size is not one this Host wrote.
  for (const field of ['clientStaticPublicKey', 'deliveryId']) {
    for (const value of [
      undefined,
      null,
      42,
      '',
      'A'.repeat(42),
      'A'.repeat(44),
      `${'A'.repeat(42)}+`, // base64, not base64url
      `${'A'.repeat(42)}=`, // padded; one spelling per byte string
      `${'A'.repeat(41)} A`,
    ]) {
      assert.equal(
        isHostAclRecord({ ...STORED, [field]: value }),
        false,
        `${field}=${JSON.stringify(value)}`,
      );
    }
  }
});

test('isHostAclRecord rejects a non-object and every missing or mistyped field', () => {
  for (const record of [
    null,
    undefined,
    'nope',
    42,
    {},
    { ...STORED, hostId: 42 },
    { ...STORED, accountId: undefined },
    { ...STORED, passkeyCredentialId: null },
    { ...STORED, passkeyPublicKeyHash: {} },
    { ...STORED, approvedAt: '1' },
    { ...STORED, approvedBy: 42 },
    { ...STORED, label: undefined },
    { ...STORED, revokedAt: 'never' },
  ]) {
    assert.equal(isHostAclRecord(record), false, JSON.stringify(record));
  }
});
