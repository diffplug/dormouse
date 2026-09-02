/**
 * IndexedDB persistence for Pocket's device key; see
 * `docs/specs/remote-security-model.md` → "Device Keys".
 */

import { generateDeviceKeyPair, type DeviceKeyPair } from 'server-lib-common';
import {
  DEVICE_KEY_STORE as STORE_NAME,
  promisifyRequest,
  promisifyTransaction,
  withPocketStore,
} from './pocket-db';

/** Where a {@link DeviceKeyPair} is persisted; faked in tests. */
export interface DeviceKeyStore {
  get(): Promise<DeviceKeyPair | null>;
  put(key: DeviceKeyPair): Promise<void>;
}

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
    get: () =>
      withPocketStore(STORE_NAME, 'readonly', async (store) => {
        const value = await promisifyRequest<StoredDeviceKey | undefined>(store.get(RECORD_KEY));
        if (!value) return null;
        return {
          publicKey: value.publicKey,
          privateKey: value.privateKey,
          devicePublicKey: value.devicePublicKey,
        };
      }),
    put: (key) =>
      withPocketStore(STORE_NAME, 'readwrite', (store) => {
        const record: StoredDeviceKey = {
          publicKey: key.publicKey as CryptoKey,
          privateKey: key.privateKey as CryptoKey,
          devicePublicKey: key.devicePublicKey,
        };
        store.put(record, RECORD_KEY);
        return promisifyTransaction(store.transaction);
      }),
  };
}

interface StoredDeviceKey {
  readonly publicKey: CryptoKey;
  readonly privateKey: CryptoKey;
  readonly devicePublicKey: string;
}
