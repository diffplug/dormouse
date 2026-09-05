import { describe, expect, it, vi } from 'vitest';
import { BurrowAcl } from 'remote-lib-common';
import { filterAclRecords, loadBurrowAcl } from './acl';

/**
 * Base64url of exactly 32 bytes is 43 characters, and `isBurrowAclRecord` checks
 * that length exactly — a fixture shorter than this is dropped on read rather
 * than tested.
 */
const CLIENT_STATIC = `client-static-key${'A'.repeat(26)}`;
const DELIVERY_ID = `delivery-id${'B'.repeat(32)}`;

function makeRecord(burrowId: string) {
  const acl = new BurrowAcl(burrowId);
  acl.approve({
    accountId: 'owner',
    passkeyCredentialId: 'cred-1',
    passkeyPublicKeyHash: 'hash-1',
    clientStaticPublicKey: CLIENT_STATIC,
    deliveryId: DELIVERY_ID,
    approvedBy: 'burrow-user',
    label: 'iPhone Safari',
  });
  return acl.records();
}

describe('burrow acl loading', () => {
  it('rehydrates what a store persisted', () => {
    const records = makeRecord('burrow-1');
    const acl = loadBurrowAcl('burrow-1', () => records);

    const active = acl.activeRecords();
    expect(active).toHaveLength(1);
    expect(active[0]?.label).toBe('iPhone Safari');
    expect(acl.hasActiveClient(CLIENT_STATIC)).toBe(true);
  });

  it('drops a record written before the end-to-end cutover', () => {
    // A pre-cutover record carries `devicePublicKey` and neither E2E field, so
    // it fails the exact-length check and never reaches the authorization
    // conjunction. There is no migration reader: this is the reset-and-re-pair,
    // and it is the whole of the Burrow-ACL version.
    expect(
      filterAclRecords('burrow-1', [
        {
          burrowId: 'burrow-1',
          accountId: 'owner',
          passkeyCredentialId: 'cred-1',
          passkeyPublicKeyHash: 'hash-1',
          devicePublicKey: 'device-1',
          approvedAt: 1,
          approvedBy: 'burrow-user',
          label: 'iPhone Safari',
          revokedAt: null,
        },
      ]),
    ).toEqual([]);
  });

  it('drops records belonging to a different burrow', () => {
    // Every store reads its ACL back as `unknown[]`, and a different burrow must
    // not inherit burrow-1's records even when the file holds them.
    const records = makeRecord('burrow-1');
    expect(filterAclRecords('burrow-2', records)).toEqual([]);
    expect(loadBurrowAcl('burrow-2', () => records).activeRecords()).toEqual([]);
  });

  it('starts empty, loudly, when the store cannot be reconciled', () => {
    // Fail closed but explicable: an empty ACL silently de-pairs every client,
    // so "all my devices vanished" must at least reach the console.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const acl = loadBurrowAcl('burrow-1', () => {
      throw new Error('globalState is unreadable');
    });
    expect(acl.activeRecords()).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
