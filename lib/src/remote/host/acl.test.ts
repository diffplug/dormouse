import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostAcl } from 'server-lib-common';
import { ACL_KEY_PREFIX, loadAclRecords, loadHostAcl, saveAclRecords } from './acl';

function stubLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
  return store;
}

function makeRecord(hostId: string) {
  const acl = new HostAcl(hostId);
  acl.approve({
    accountId: 'owner',
    passkeyCredentialId: 'cred-1',
    passkeyPublicKeyHash: 'hash-1',
    devicePublicKey: 'device-1',
    approvedBy: 'host-user',
    label: 'iPhone Safari',
  });
  return acl.records();
}

describe('remote-host acl persistence', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('round-trips records through localStorage', () => {
    const store = stubLocalStorage();
    const records = makeRecord('host-1');
    saveAclRecords('host-1', records);

    expect(store.get(`${ACL_KEY_PREFIX}host-1`)).toBe(JSON.stringify(records));
    expect(loadAclRecords('host-1')).toEqual(records);

    const acl = loadHostAcl('host-1');
    const active = acl.activeRecords();
    expect(active).toHaveLength(1);
    expect(active[0]?.label).toBe('iPhone Safari');
    expect(acl.hasActiveDevice('device-1')).toBe(true);
  });

  it('drops records belonging to a different host', () => {
    stubLocalStorage();
    saveAclRecords('host-1', makeRecord('host-1'));
    // A different host must not inherit host-1's ACL.
    expect(loadAclRecords('host-2')).toEqual([]);
    expect(loadHostAcl('host-2').activeRecords()).toEqual([]);
  });

  it('returns an empty ACL for malformed storage', () => {
    const store = stubLocalStorage();
    store.set(`${ACL_KEY_PREFIX}host-1`, 'not json');
    expect(loadAclRecords('host-1')).toEqual([]);
    expect(loadHostAcl('host-1').activeRecords()).toEqual([]);
  });

  it('treats a missing localStorage as an empty ACL', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(loadAclRecords('host-1')).toEqual([]);
    expect(() => saveAclRecords('host-1', [])).not.toThrow();
  });
});
