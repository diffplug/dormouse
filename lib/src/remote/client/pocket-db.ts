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
    request.onsuccess = () => resolve(request.result);
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

/** The IndexedDB-backed {@link KnownHostStore}. */
export function indexedDbKnownHostStore(): KnownHostStore {
  return {
    async get(hostId) {
      const db = await openPocketDb();
      try {
        const value = await promisifyRequest<KnownHostV1 | undefined>(
          db.transaction(KNOWN_HOSTS_STORE, 'readonly').objectStore(KNOWN_HOSTS_STORE).get(hostId),
        );
        return value ?? null;
      } finally {
        db.close();
      }
    },
    async put(record) {
      // Before the first write, per the storage-durability rule.
      await requestPersistenceOnce();
      const db = await openPocketDb();
      try {
        const tx = db.transaction(KNOWN_HOSTS_STORE, 'readwrite');
        tx.objectStore(KNOWN_HOSTS_STORE).put(record);
        await promisifyTransaction(tx);
      } finally {
        db.close();
      }
    },
    async delete(hostId) {
      const db = await openPocketDb();
      try {
        const tx = db.transaction(KNOWN_HOSTS_STORE, 'readwrite');
        tx.objectStore(KNOWN_HOSTS_STORE).delete(hostId);
        await promisifyTransaction(tx);
      } finally {
        db.close();
      }
    },
    async list() {
      const db = await openPocketDb();
      try {
        return await promisifyRequest<KnownHostV1[]>(
          db.transaction(KNOWN_HOSTS_STORE, 'readonly').objectStore(KNOWN_HOSTS_STORE).getAll(),
        );
      } finally {
        db.close();
      }
    },
  };
}

/** The IndexedDB-backed {@link PendingDeletionStore}. */
export function indexedDbPendingDeletionStore(): PendingDeletionStore {
  return {
    async put(record) {
      await requestPersistenceOnce();
      const db = await openPocketDb();
      try {
        const tx = db.transaction(PENDING_DELETIONS_STORE, 'readwrite');
        tx.objectStore(PENDING_DELETIONS_STORE)
          .put(record, pendingDeletionKey(record.hostId, record.deliveryId));
        await promisifyTransaction(tx);
      } finally {
        db.close();
      }
    },
    async delete(hostId, deliveryId) {
      const db = await openPocketDb();
      try {
        const tx = db.transaction(PENDING_DELETIONS_STORE, 'readwrite');
        tx.objectStore(PENDING_DELETIONS_STORE).delete(pendingDeletionKey(hostId, deliveryId));
        await promisifyTransaction(tx);
      } finally {
        db.close();
      }
    },
    async list() {
      const db = await openPocketDb();
      try {
        return await promisifyRequest<PendingDeliveryDeletionV1[]>(
          db
            .transaction(PENDING_DELETIONS_STORE, 'readonly')
            .objectStore(PENDING_DELETIONS_STORE)
            .getAll(),
        );
      } finally {
        db.close();
      }
    },
  };
}

/** An in-memory {@link KnownHostStore} for tests and for a browser with no IndexedDB. */
export function memoryKnownHostStore(): KnownHostStore {
  const records = new Map<string, KnownHostV1>();
  return {
    get: async (hostId) => records.get(hostId) ?? null,
    put: async (record) => void records.set(record.hostId, record),
    delete: async (hostId) => void records.delete(hostId),
    list: async () => [...records.values()],
  };
}

/** An in-memory {@link PendingDeletionStore}, same rationale. */
export function memoryPendingDeletionStore(): PendingDeletionStore {
  const records = new Map<string, PendingDeliveryDeletionV1>();
  return {
    put: async (record) =>
      void records.set(pendingDeletionKey(record.hostId, record.deliveryId), record),
    delete: async (hostId, deliveryId) =>
      void records.delete(pendingDeletionKey(hostId, deliveryId)),
    list: async () => [...records.values()],
  };
}
