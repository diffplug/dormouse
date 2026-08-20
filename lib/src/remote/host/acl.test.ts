import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostAcl } from 'server-lib-common';
import { ACL_KEY_PREFIX, clearAclRecords, loadAclRecords, loadHostAcl } from './acl';

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

/** What a webview-resident Host left behind, which is all this module reads now. */
function seed(store: Map<string, string>, hostId: string): ReturnType<typeof makeRecord> {
  const records = makeRecord(hostId);
  store.set(`${ACL_KEY_PREFIX}${hostId}`, JSON.stringify(records));
  return records;
}

describe('remote-host acl persistence', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads back what a webview-resident Host persisted', () => {
    const store = stubLocalStorage();
    const records = seed(store, 'host-1');

    expect(loadAclRecords('host-1')).toEqual(records);

    const acl = loadHostAcl('host-1', loadAclRecords);
    const active = acl.activeRecords();
    expect(active).toHaveLength(1);
    expect(active[0]?.label).toBe('iPhone Safari');
    expect(acl.hasActiveDevice('device-1')).toBe(true);
  });

  it('drops records belonging to a different host', () => {
    const store = stubLocalStorage();
    seed(store, 'host-1');
    // A different host must not inherit host-1's ACL.
    expect(loadAclRecords('host-2')).toEqual([]);
    expect(loadHostAcl('host-2', loadAclRecords).activeRecords()).toEqual([]);
  });

  it('returns an empty ACL for malformed storage', () => {
    const store = stubLocalStorage();
    store.set(`${ACL_KEY_PREFIX}host-1`, 'not json');
    expect(loadAclRecords('host-1')).toEqual([]);
    expect(loadHostAcl('host-1', loadAclRecords).activeRecords()).toEqual([]);
  });

  it('clears the copy once the service has taken custody of it', () => {
    // Left behind it would be a second, diverging ACL for the same hostId.
    const store = stubLocalStorage();
    seed(store, 'host-1');
    clearAclRecords('host-1');
    expect(loadAclRecords('host-1')).toEqual([]);
  });

  it('treats a missing localStorage as an empty ACL', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(loadAclRecords('host-1')).toEqual([]);
    expect(() => clearAclRecords('host-1')).not.toThrow();
  });
});
