/**
 * Pocket's IndexedDB layout (`docs/specs/pocket-app.md` → "What Pocket
 * stores"): the v3 upgrade, and the two stores that survive it.
 *
 * `fake-indexeddb` structured-clones what it is handed, and a `CryptoKey` is
 * not cloneable there, so the records below carry plain stand-ins where the
 * real ones carry keys. What is under test is the database shape and the store
 * operations, not what a browser does with key material.
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEVICE_KEY_STORE,
  KNOWN_HOSTS_STORE,
  PENDING_DELETIONS_STORE,
  POCKET_DB_NAME,
  POCKET_DB_VERSION,
  indexedDbKnownHostStore,
  indexedDbPendingDeletionStore,
  openPocketDb,
  pendingDeletionKey,
  persistStorage,
  promisifyRequest,
  promisifyTransaction,
  type KnownHostV1,
} from './pocket-db';

function knownHost(hostId: string, overrides: Partial<KnownHostV1> = {}): KnownHostV1 {
  return {
    hostId,
    accountId: 'owner',
    label: 'Laptop',
    hostStaticPublicKey: 'aG9zdC1zdGF0aWM',
    clientStaticKeyPair: {
      // A stand-in: see the file header.
      privateKey: { kind: 'private' } as unknown as CryptoKey,
      publicKeyRaw: 'Y2xpZW50LXN0YXRpYw',
    },
    passkeyCredentialId: 'cred-1',
    passkeyPublicKeyHash: 'hash-1',
    authorization: { state: 'paired', deliveryId: 'delivery-1', approvedAt: 1 },
    ...overrides,
  };
}

beforeEach(() => {
  // A fresh database per test; `fake-indexeddb/auto` installs one factory for
  // the whole file.
  vi.stubGlobal('indexedDB', new IDBFactory());
});

afterEach(() => vi.unstubAllGlobals());

describe('the pocket database', () => {
  // First, because the persistence request is made once per page life and
  // every later test writes.
  it('asks for persistent storage once, before the first record is written', async () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal('navigator', { storage: { persist } });

    const hosts = indexedDbKnownHostStore();
    await hosts.put(knownHost('host-1'));
    await hosts.put(knownHost('host-2'));
    await indexedDbPendingDeletionStore().put({
      hostId: 'host-1',
      deliveryId: 'delivery-1',
      queuedAt: 1,
    });

    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('treats a browser with no storage manager as ordinary storage', async () => {
    // Safari answers nothing here, and losing the keys is recoverable by
    // re-pairing — so this must never be an error.
    vi.stubGlobal('navigator', {});
    expect(await persistStorage()).toBe(false);
    vi.stubGlobal('navigator', {
      storage: {
        persist: () => {
          throw new Error('denied');
        },
      },
    });
    expect(await persistStorage()).toBe(false);
  });

  /**
   * Both earlier versions land in the same shape. The device key is gone with
   * the protocol that used it, and a key nothing can use is only a credential
   * left lying about.
   */
  it.each([1, 2])('upgrades a v%i database by deleting the device key', async (from) => {
    const older = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(POCKET_DB_NAME, from);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore(DEVICE_KEY_STORE);
        if (from >= 2) {
          db.createObjectStore(KNOWN_HOSTS_STORE, { keyPath: 'hostId' });
          db.createObjectStore(PENDING_DELETIONS_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const seed = older.transaction(DEVICE_KEY_STORE, 'readwrite');
    seed.objectStore(DEVICE_KEY_STORE).put({ devicePublicKey: 'BDevice' }, 'default');
    await promisifyTransaction(seed);
    older.close();

    const db = await openPocketDb();
    try {
      expect(db.version).toBe(POCKET_DB_VERSION);
      expect([...db.objectStoreNames].sort()).toEqual([
        KNOWN_HOSTS_STORE,
        PENDING_DELETIONS_STORE,
      ]);
      expect(db.objectStoreNames.contains(DEVICE_KEY_STORE)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('releases an open handle when another tab asks for a newer version', async () => {
    // A connection this tab left open would block the next version's upgrade
    // with no timeout, so the handle has to yield on `versionchange`.
    const held = await openPocketDb();
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(POCKET_DB_NAME, POCKET_DB_VERSION + 1);
      request.onblocked = () => reject(new Error('blocked: the open handle was never released'));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(upgraded.version).toBe(POCKET_DB_VERSION + 1);
    upgraded.close();
    held.close();
  });

  it('names the blocker instead of hanging when an old tab holds v1 open', async () => {
    // A pre-v2 connection has no `versionchange` handler of its own, so the
    // upgrade cannot proceed and neither `success` nor `error` ever fires.
    const stale = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(POCKET_DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(DEVICE_KEY_STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await expect(openPocketDb()).rejects.toThrow(/older version/);
    } finally {
      stale.close();
    }
  });

  it('creates every store on a browser that has no database yet', async () => {
    const db = await openPocketDb();
    try {
      expect(db.version).toBe(POCKET_DB_VERSION);
      expect([...db.objectStoreNames].sort()).toEqual([
        KNOWN_HOSTS_STORE,
        PENDING_DELETIONS_STORE,
      ]);
    } finally {
      db.close();
    }
  });

  it('puts, gets, lists, and deletes known hosts by hostId', async () => {
    const store = indexedDbKnownHostStore();
    expect(await store.get('host-1')).toBeNull();

    await store.put(knownHost('host-1'));
    await store.put(knownHost('host-2', { authorization: { state: 'pairing-required' } }));
    expect((await store.get('host-1'))?.label).toBe('Laptop');
    expect((await store.get('host-2'))?.authorization).toEqual({ state: 'pairing-required' });
    expect((await store.list()).map((record) => record.hostId).sort()).toEqual([
      'host-1',
      'host-2',
    ]);

    // Keyed by `hostId`, so a second put for the same Host replaces it.
    await store.put(knownHost('host-1', { label: 'Renamed' }));
    expect(await store.list()).toHaveLength(2);
    expect((await store.get('host-1'))?.label).toBe('Renamed');

    await store.delete('host-1');
    expect(await store.get('host-1')).toBeNull();
    expect(await store.list()).toHaveLength(1);
  });

  it('files a pending deletion under hostId:deliveryId', async () => {
    const store = indexedDbPendingDeletionStore();
    await store.put({ hostId: 'host-1', deliveryId: 'delivery-1', queuedAt: 1 });
    // Two deliveries for one Host is the normal case after a re-pair, so the
    // key cannot be the hostId alone.
    await store.put({ hostId: 'host-1', deliveryId: 'delivery-2', queuedAt: 2 });
    expect(await store.list()).toHaveLength(2);

    const db = await openPocketDb();
    try {
      const keys = await promisifyRequest<IDBValidKey[]>(
        db
          .transaction(PENDING_DELETIONS_STORE, 'readonly')
          .objectStore(PENDING_DELETIONS_STORE)
          .getAllKeys(),
      );
      expect(keys).toEqual(['host-1:delivery-1', 'host-1:delivery-2']);
      expect(pendingDeletionKey('host-1', 'delivery-1')).toBe('host-1:delivery-1');
    } finally {
      db.close();
    }

    await store.delete('host-1', 'delivery-1');
    expect(await store.list()).toEqual([
      { hostId: 'host-1', deliveryId: 'delivery-2', queuedAt: 2 },
    ]);
    // Deleting one that is not there is not an error: the queue is drained by
    // retry, and a duplicate drain must not fail.
    await store.delete('host-1', 'delivery-1');
  });
});
