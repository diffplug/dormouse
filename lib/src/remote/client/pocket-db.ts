/**
 * Pocket's IndexedDB: the one place the database name, its version, and its
 * object stores are written down (`docs/specs/pocket-app.md` → "What Pocket
 * stores"). Every store in this app opens through {@link openPocketDb}, so two
 * of them can never disagree about the version — a second `indexedDB.open` at
 * the old version fails outright once the first has upgraded.
 *
 * The records here are the end-to-end identities of
 * `docs/specs/remote-security-model.md`.
 */

export const POCKET_DB_NAME = 'dormouse-pocket';

/**
 * v1 was `device-key` alone; v2 added the two E2E stores beside it; v3 deletes
 * `device-key`, which nothing reads any more. A phone arriving from either
 * earlier version lands in the same shape, and the deletion is what stops a
 * superseded Client identity from outliving the protocol that used it.
 */
export const POCKET_DB_VERSION = 3;

/** Deleted at v3; named only so the upgrade and its test can say what goes. */
export const DEVICE_KEY_STORE = 'device-key';
export const KNOWN_BURROWS_STORE = 'known-burrows';
export const PENDING_DELETIONS_STORE = 'pending-deletions';

/** How this Client stands with one Burrow, once a pairing has answered. */
export type KnownBurrowAuthorization =
  | {
      readonly state: 'paired';
      /** The capability the Burrow minted for push delivery to this Client. */
      readonly deliveryId: string;
      readonly approvedAt: number;
    }
  /**
   * Authorization is gone, the pin is not. Re-pairing against a Burrow whose
   * static changed is a security error rather than a fresh start, so the
   * record survives losing its authorization.
   */
  | { readonly state: 'pairing-required' };

/**
 * One Burrow this Client has paired with, keyed by `burrowId`.
 *
 * The Client static is per Burrow and never shared between them, and its private
 * half is a nonextractable `CryptoKey` stored directly — never exported.
 */
export interface KnownBurrowV1 {
  readonly burrowId: string;
  readonly accountId: string;
  /**
   * What to call this machine. The Burrow's own label, as it arrived inside the
   * encrypted pairing outcome — never the Relay's copy, which a Client is not
   * told and which stops existing in stage 4c.
   */
  readonly label: string;
  /** The pinned Burrow Noise static, base64url. A change is a terminal error. */
  readonly burrowStaticPublicKey: string;
  /** This Client's static for this Burrow; only the private half is a key object. */
  readonly clientStaticKeyPair: {
    readonly privateKey: CryptoKey;
    /** The raw 32-byte public half, base64url — what the ACL records. */
    readonly publicKeyRaw: string;
  };
  /** The sole `allowCredentials` entry for this Burrow. */
  readonly passkeyCredentialId: string;
  readonly passkeyPublicKeyHash: string;
  readonly authorization: KnownBurrowAuthorization;
}

/**
 * A delivery mapping this Client owes the Relay a deletion for, written
 * *before* the `KnownBurrowV1` forgets the id — the id is the only handle that
 * can delete the row, so losing it before the deletion lands strands it.
 */
export interface PendingDeliveryDeletionV1 {
  readonly burrowId: string;
  readonly deliveryId: string;
  readonly queuedAt: number;
}

/** Where {@link KnownBurrowV1} records live; faked in tests. */
export interface KnownBurrowStore {
  get(burrowId: string): Promise<KnownBurrowV1 | null>;
  put(record: KnownBurrowV1): Promise<void>;
  delete(burrowId: string): Promise<void>;
  list(): Promise<KnownBurrowV1[]>;
}

/** Where {@link PendingDeliveryDeletionV1} tombstones live; faked in tests. */
export interface PendingDeletionStore {
  put(record: PendingDeliveryDeletionV1): Promise<void>;
  delete(burrowId: string, deliveryId: string): Promise<void>;
  list(): Promise<PendingDeliveryDeletionV1[]>;
}

/**
 * The key one tombstone is filed under. A pair rather than the `burrowId` alone,
 * because a Burrow that has been re-paired can owe deletions for more than one
 * delivery id at a time.
 *
 * **Neither half may contain `:`**, or two different pairs could file under one
 * key. Both are base64url today — a `burrowId` is `toBase64Url(randomBytes(16))`
 * from the Relay — so the separator is unambiguous; a component that stops
 * being base64url needs a framed key, not a longer separator.
 */
export function pendingDeletionKey(burrowId: string, deliveryId: string): string {
  return `${burrowId}:${deliveryId}`;
}

/**
 * Open the database, creating whatever stores this version is missing and
 * deleting the one it has retired.
 *
 * The upgrade is written as "create what is absent, drop what is gone" rather
 * than as a chain of per-version steps: a browser arriving from v1, from v2, or
 * with no database at all lands in exactly the same shape.
 */
export function openPocketDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(POCKET_DB_NAME, POCKET_DB_VERSION);
    /**
     * Whether `blocked` already rejected. It is not a terminal state: the other
     * tab can still close, and the open then *succeeds* — handing back a
     * connection nobody is holding a reference to, which is exactly what blocks
     * the next upgrade. So a late success is closed rather than resolved.
     */
    let rejected = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      // The idiom holds only while no upgrade transforms *data*: the first one
      // that re-keys records or backfills an index has to branch on
      // `event.oldVersion` instead.
      if (db.objectStoreNames.contains(DEVICE_KEY_STORE)) {
        db.deleteObjectStore(DEVICE_KEY_STORE);
      }
      if (!db.objectStoreNames.contains(KNOWN_BURROWS_STORE)) {
        db.createObjectStore(KNOWN_BURROWS_STORE, { keyPath: 'burrowId' });
      }
      // Explicit keys: the key is a pair of fields, not one of them.
      if (!db.objectStoreNames.contains(PENDING_DELETIONS_STORE)) {
        db.createObjectStore(PENDING_DELETIONS_STORE);
      }
    };
    // A connection on a build older than the one that added the
    // `versionchange` handler below can hold the upgrade off; neither `success`
    // nor `error` follows while it does. Naming the failure beats an unbounded
    // wait — the caller can tell the user to close the other tab, which nothing
    // can do from a hang.
    request.onblocked = () => {
      rejected = true;
      reject(new Error('another tab is holding the Pocket database at an older version'));
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab asking for a newer version is blocked for as long as this
      // connection is open, and the block has no timeout. Closing on the
      // `versionchange` notice is what lets the next version land while this
      // tab is up; every operation here already closes its own handle, so the
      // only reader this can interrupt is one that never released it.
      db.onversionchange = () => db.close();
      if (rejected) {
        db.close();
        return;
      }
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('failed to open IndexedDB'));
  });
}

export function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export function promisifyTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/**
 * Ask the browser to keep this origin's storage, best-effort.
 *
 * **Never throws and never blocks a write.** The keys here are recoverable by
 * re-pairing (`docs/specs/remote-security-model.md` → Client static loss), so a
 * browser that refuses, or has no `navigator.storage` at all — Safari answers
 * nothing here — gets the ordinary eviction-prone storage rather than an
 * error. Feature-detected rather than window-detected, because the service
 * worker imports this module too and has no `StorageManager.persist`.
 */
export async function persistStorage(): Promise<boolean> {
  try {
    const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
    if (typeof storage?.persist !== 'function') return false;
    return await storage.persist();
  } catch {
    return false;
  }
}

let persistRequested = false;

/**
 * Asked once per page life, before the first record is written. The answer
 * does not change between writes, and a permission that can prompt is worse
 * for being asked twice.
 */
async function requestPersistenceOnce(): Promise<void> {
  if (persistRequested) return;
  persistRequested = true;
  await persistStorage();
}

/**
 * Run one transaction against one store, closing the connection on every path.
 * A leaked handle blocks the next version upgrade, so no caller opens the
 * database itself.
 */
export async function withPocketStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const db = await openPocketDb();
  try {
    return await run(db.transaction(storeName, mode).objectStore(storeName));
  } finally {
    db.close();
  }
}

/** The IndexedDB-backed {@link KnownBurrowStore}. */
export function indexedDbKnownBurrowStore(): KnownBurrowStore {
  return {
    get: (burrowId) =>
      withPocketStore(KNOWN_BURROWS_STORE, 'readonly', async (store) => {
        const value = await promisifyRequest<KnownBurrowV1 | undefined>(store.get(burrowId));
        return value ?? null;
      }),
    async put(record) {
      // Before the first write, per the storage-durability rule.
      await requestPersistenceOnce();
      await withPocketStore(KNOWN_BURROWS_STORE, 'readwrite', (store) => {
        store.put(record);
        return promisifyTransaction(store.transaction);
      });
    },
    delete: (burrowId) =>
      withPocketStore(KNOWN_BURROWS_STORE, 'readwrite', (store) => {
        store.delete(burrowId);
        return promisifyTransaction(store.transaction);
      }),
    list: () =>
      withPocketStore(KNOWN_BURROWS_STORE, 'readonly', (store) =>
        promisifyRequest<KnownBurrowV1[]>(store.getAll()),
      ),
  };
}

/** The IndexedDB-backed {@link PendingDeletionStore}. */
export function indexedDbPendingDeletionStore(): PendingDeletionStore {
  return {
    async put(record) {
      await requestPersistenceOnce();
      await withPocketStore(PENDING_DELETIONS_STORE, 'readwrite', (store) => {
        store.put(record, pendingDeletionKey(record.burrowId, record.deliveryId));
        return promisifyTransaction(store.transaction);
      });
    },
    delete: (burrowId, deliveryId) =>
      withPocketStore(PENDING_DELETIONS_STORE, 'readwrite', (store) => {
        store.delete(pendingDeletionKey(burrowId, deliveryId));
        return promisifyTransaction(store.transaction);
      }),
    list: () =>
      withPocketStore(PENDING_DELETIONS_STORE, 'readonly', (store) =>
        promisifyRequest<PendingDeliveryDeletionV1[]>(store.getAll()),
      ),
  };
}
