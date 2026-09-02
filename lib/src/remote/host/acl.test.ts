import { describe, expect, it, vi } from 'vitest';
import { HostAcl } from 'server-lib-common';
import { filterAclRecords, loadHostAcl } from './acl';

/**
 * Base64url of exactly 32 bytes is 43 characters, and `isHostAclRecord` checks
 * that length exactly — a fixture shorter than this is dropped on read rather
 * than tested.
 */
const CLIENT_STATIC = `client-static-key${'A'.repeat(26)}`;
const DELIVERY_ID = `delivery-id${'B'.repeat(32)}`;

function makeRecord(hostId: string) {
  const acl = new HostAcl(hostId);
  acl.approve({
    accountId: 'owner',
    passkeyCredentialId: 'cred-1',
    passkeyPublicKeyHash: 'hash-1',
    clientStaticPublicKey: CLIENT_STATIC,
    deliveryId: DELIVERY_ID,
    approvedBy: 'host-user',
    label: 'iPhone Safari',
  });
  return acl.records();
}

describe('remote-host acl loading', () => {
  it('rehydrates what a store persisted', () => {
    const records = makeRecord('host-1');
    const acl = loadHostAcl('host-1', () => records);

    const active = acl.activeRecords();
    expect(active).toHaveLength(1);
    expect(active[0]?.label).toBe('iPhone Safari');
    expect(acl.hasActiveClient(CLIENT_STATIC)).toBe(true);
  });

  it('drops a record written before the end-to-end cutover', () => {
    // A pre-cutover record carries `devicePublicKey` and neither E2E field, so
    // it fails the exact-length check and never reaches the authorization
    // conjunction. There is no migration reader: this is the reset-and-re-pair,
    // and it is the whole of the Host-ACL version.
    expect(
      filterAclRecords('host-1', [
        {
          hostId: 'host-1',
          accountId: 'owner',
          passkeyCredentialId: 'cred-1',
          passkeyPublicKeyHash: 'hash-1',
          devicePublicKey: 'device-1',
          approvedAt: 1,
          approvedBy: 'host-user',
          label: 'iPhone Safari',
          revokedAt: null,
        },
      ]),
    ).toEqual([]);
  });

  it('drops records belonging to a different host', () => {
    // Every store reads its ACL back as `unknown[]`, and a different host must
    // not inherit host-1's records even when the file holds them.
    const records = makeRecord('host-1');
    expect(filterAclRecords('host-2', records)).toEqual([]);
    expect(loadHostAcl('host-2', () => records).activeRecords()).toEqual([]);
  });

  it('starts empty, loudly, when the store cannot be reconciled', () => {
    // Fail closed but explicable: an empty ACL silently de-pairs every client,
    // so "all my devices vanished" must at least reach the console.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const acl = loadHostAcl('host-1', () => {
      throw new Error('globalState is unreadable');
    });
    expect(acl.activeRecords()).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
