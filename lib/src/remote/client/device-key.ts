/**
 * The Pocket device key: a non-extractable ECDSA P-256 keypair that is this
 * browser's long-lived Client identity (docs/specs/remote-security-model.md).
 * The `CryptoKey` objects are persisted directly in IndexedDB — never exported
 * — so the private key material never leaves the runtime, exactly as
 * `generateDeviceKeyPair`'s contract intends.
 *
 * The store is injected into {@link getOrCreateDeviceKey} so its logic is
 * unit-testable without IndexedDB (the browser default is
 * {@link indexedDbDeviceKeyStore}).
 */

import { generateDeviceKeyPair, type DeviceKeyPair } from 'server-lib-common';

/** Where a {@link DeviceKeyPair} is persisted; faked in tests. */
export interface DeviceKeyStore {
  get(): Promise<DeviceKeyPair | null>;
  put(key: DeviceKeyPair): Promise<void>;
}

const DB_NAME = 'dormouse-pocket';
const STORE_NAME = 'device-key';
const RECORD_KEY = 'default';

/**
 * Return this device's keypair, generating and persisting one on first run.
 * The private key is non-extractable; only its base64url public point
 * (`devicePublicKey`) ever crosses the wire.
 */
export async function getOrCreateDeviceKey(
  store: DeviceKeyStore = indexedDbDeviceKeyStore(),
): Promise<DeviceKeyPair> {
  const existing = await store.get();
  if (existing) return existing;
  const created = await generateDeviceKeyPair();
  await store.put(created);
  return created;
}

/** A tiny one-object-store IndexedDB wrapper holding the `CryptoKey` objects. */
export function indexedDbDeviceKeyStore(): DeviceKeyStore {
  return {
    async get() {
      const db = await openDb();
      try {
        const value = await promisifyRequest<StoredDeviceKey | undefined>(
          db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(RECORD_KEY),
        );
        if (!value) return null;
        return {
          publicKey: value.publicKey,
          privateKey: value.privateKey,
          devicePublicKey: value.devicePublicKey,
        };
      } finally {
        db.close();
      }
    },
    async put(key) {
      const db = await openDb();
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const record: StoredDeviceKey = {
          publicKey: key.publicKey as CryptoKey,
          privateKey: key.privateKey as CryptoKey,
          devicePublicKey: key.devicePublicKey,
        };
        tx.objectStore(STORE_NAME).put(record, RECORD_KEY);
        await promisifyTransaction(tx);
      } finally {
        db.close();
      }
    },
  };
}

interface StoredDeviceKey {
  readonly publicKey: CryptoKey;
  readonly privateKey: CryptoKey;
  readonly devicePublicKey: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('failed to open IndexedDB'));
  });
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function promisifyTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}
