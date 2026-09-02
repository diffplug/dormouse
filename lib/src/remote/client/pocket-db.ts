/**
 * Pocket's IndexedDB: the one place the database name, its version, and its
 * object stores are written down (`docs/specs/pocket-app.md` → "What Pocket
 * stores"). Every store in this app opens through {@link openPocketDb}, so two
 * of them can never disagree about the version — a second `indexedDB.open` at
 * the old version fails outright once the first has upgraded.
 *
 * The records here are the end-to-end identities of
 * `docs/specs/remote-security-model.md`; nothing in the app reads or writes
 * them yet.
 */

export const POCKET_DB_NAME = 'dormouse-pocket';

/** v1 was `device-key` alone; v2 adds the two E2E stores beside it. */
export const POCKET_DB_VERSION = 2;

export const DEVICE_KEY_STORE = 'device-key';
export const KNOWN_HOSTS_STORE = 'known-hosts';
export const PENDING_DELETIONS_STORE = 'pending-deletions';

/** How this Client stands with one Host, once a pairing has answered. */
export type KnownHostAuthorization =
  | {
      readonly state: 'paired';
      /** The capability the Host minted for push delivery to this Client. */
      readonly deliveryId: string;
      readonly approvedAt: number;
    }
  /**
   * Authorization is gone, the pin is not. Re-pairing against a Host whose
   * static changed is a security error rather than a fresh start, so the
   * record survives losing its authorization.
   */
  | { readonly state: 'pairing-required' };

/**
 * One Host this Client has paired with, keyed by `hostId`.
 *
 * The Client static is per Host and never shared between them, and its private
 * half is a nonextractable `CryptoKey` stored directly — never exported, the
 * same rule the device key has always followed.
 */
export interface KnownHostV1 {
  readonly hostId: string;
  readonly accountId: string;
  /** Local, chosen here; the Host's own label arrives inside encrypted outcomes. */
  readonly label: string;
  /** The pinned Host Noise static, base64url. A change is a terminal error. */
  readonly hostStaticPublicKey: string;
  readonly clientStaticKeyPair: {
    readonly privateKey: CryptoKey;
    readonly publicKey: CryptoKey;
    /** The raw 32-byte public half, base64url — what the ACL records. */
    readonly publicKeyRaw: string;
  };
  /** The sole `allowCredentials` entry for this Host. */
  readonly passkeyCredentialId: string;
  readonly passkeyPublicKeyHash: string;
  readonly authorization: KnownHostAuthorization;
}

/**
 * A delivery mapping this Client owes the Server a deletion for, written
 * *before* the `KnownHostV1` forgets the id — the id is the only handle that
 * can delete the row, so losing it before the deletion lands strands it.
 */
export interface PendingDeliveryDeletionV1 {
  readonly hostId: string;
  readonly deliveryId: string;
  readonly queuedAt: number;
}

/** Where {@link KnownHostV1} records live; faked in tests. */
export interface KnownHostStore {
  get(hostId: string): Promise<KnownHostV1 | null>;
  put(record: KnownHostV1): Promise<void>;
  delete(hostId: string): Promise<void>;
  list(): Promise<KnownHostV1[]>;
}

/** Where {@link PendingDeliveryDeletionV1} tombstones live; faked in tests. */
export interface PendingDeletionStore {
  put(record: PendingDeliveryDeletionV1): Promise<void>;
  delete(hostId: string, deliveryId: string): Promise<void>;
  list(): Promise<PendingDeliveryDeletionV1[]>;
}

/**
 * The key one tombstone is filed under. A pair rather than the `hostId` alone,
 * because a Host that has been re-paired can owe deletions for more than one
 * delivery id at a time.
 *
 * **Neither half may contain `:`**, or two different pairs could file under one
 * key. Both are base64url today — a `hostId` is `toBase64Url(randomBytes(16))`
 * from the Server — so the separator is unambiguous; a component that stops
 * being base64url needs a framed key, not a longer separator.
 */
export function pendingDeletionKey(hostId: string, deliveryId: string): string {
  return `${hostId}:${deliveryId}`;
}

/**
 * Open the database, creating whatever stores this version is missing.
 *
 * The upgrade is written as "create what is absent" rather than as a v1→v2
 * migration step: a browser arriving from v1 keeps its `device-key` record
 * untouched, and one arriving with no database at all lands in the same shape.
 */
export function openPocketDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(POCKET_DB_NAME, POCKET_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // Out-of-line key, as v1 created it — the record has no id field.
      if (!db.objectStoreNames.contains(DEVICE_KEY_STORE)) {
        db.createObjectStore(DEVICE_KEY_STORE);
      }
      if (!db.objectStoreNames.contains(KNOWN_HOSTS_STORE)) {
        db.createObjectStore(KNOWN_HOSTS_STORE, { keyPath: 'hostId' });
      }
      // Explicit keys: the key is a pair of fields, not one of them.
      if (!db.objectStoreNames.contains(PENDING_DELETIONS_STORE)) {
        db.createObjectStore(PENDING_DELETIONS_STORE);
      }
    };
    // A connection on the pre-v2 build has no `versionchange` handler, so it
    // can hold the upgrade off; neither `success` nor `error` follows while it
    // does. Naming the failure beats an unbounded wait — the caller can tell
    // the user to close the other tab, which nothing can do from a hang.
    request.onblocked = () =>
      reject(new Error('another tab is holding the Pocket database at an older version'));
    request.onsuccess = () => {
      const db = request.result;
      // Another tab asking for a newer version is blocked for as long as this
      // connection is open, and the block has no timeout. Closing on the
      // `versionchange` notice is what lets v3 land while this tab is up;
      // every operation here already closes its own handle, so the only reader
      // this can interrupt is one that never released it.
      db.onversionchange = () => db.close();
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
 * re-pairing (`docs/specs/remote-security-model.md` → Device Key Loss), so a
 * browser that refuses, or has no `navigator.storage` at all — Safari answers
 * nothing here — gets the ordinary eviction-prone storage rather than an
 * error.
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

/** The IndexedDB-backed {@link KnownHostStore}. */
export function indexedDbKnownHostStore(): KnownHostStore {
  return {
    get: (hostId) =>
      withPocketStore(KNOWN_HOSTS_STORE, 'readonly', async (store) => {
        const value = await promisifyRequest<KnownHostV1 | undefined>(store.get(hostId));
        return value ?? null;
      }),
    async put(record) {
      // Before the first write, per the storage-durability rule.
      await requestPersistenceOnce();
      await withPocketStore(KNOWN_HOSTS_STORE, 'readwrite', (store) => {
        store.put(record);
        return promisifyTransaction(store.transaction);
      });
    },
    delete: (hostId) =>
      withPocketStore(KNOWN_HOSTS_STORE, 'readwrite', (store) => {
        store.delete(hostId);
        return promisifyTransaction(store.transaction);
      }),
    list: () =>
      withPocketStore(KNOWN_HOSTS_STORE, 'readonly', (store) =>
        promisifyRequest<KnownHostV1[]>(store.getAll()),
      ),
  };
}

/** The IndexedDB-backed {@link PendingDeletionStore}. */
export function indexedDbPendingDeletionStore(): PendingDeletionStore {
  return {
    async put(record) {
      await requestPersistenceOnce();
      await withPocketStore(PENDING_DELETIONS_STORE, 'readwrite', (store) => {
        store.put(record, pendingDeletionKey(record.hostId, record.deliveryId));
        return promisifyTransaction(store.transaction);
      });
    },
    delete: (hostId, deliveryId) =>
      withPocketStore(PENDING_DELETIONS_STORE, 'readwrite', (store) => {
        store.delete(pendingDeletionKey(hostId, deliveryId));
        return promisifyTransaction(store.transaction);
      }),
    list: () =>
      withPocketStore(PENDING_DELETIONS_STORE, 'readonly', (store) =>
        promisifyRequest<PendingDeliveryDeletionV1[]>(store.getAll()),
      ),
  };
}
