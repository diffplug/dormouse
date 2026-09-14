import { toBase64Url } from 'remote-lib-common';

const encoder = new TextEncoder();

export type PocketKeyStorageMode = 'native' | 'encrypted';
interface EncryptedPrivateKey {
  readonly format: 'aes-gcm-x25519-v1';
  readonly wrappingKey: CryptoKey;
  readonly iv: Uint8Array<ArrayBuffer>;
  readonly ciphertext: ArrayBuffer;
  readonly context: string;
}
export type StoredPocketPrivateKey = CryptoKey | EncryptedPrivateKey;

// Keep the encrypted representation with its runtime key, including after a
// worker read. Authorization-only rewrites must not serialize X25519 again.
const envelopes = new WeakMap<CryptoKey, EncryptedPrivateKey>();
const contextFor = (burrowId: string, publicKeyRaw: string) =>
  JSON.stringify(['dormouse/pocket-private-key/v1', burrowId, publicKeyRaw]);

export async function generatePocketKeyPair(mode: PocketKeyStorageMode, burrowId: string): Promise<CryptoKeyPair> {
  const pair = await crypto.subtle.generateKey('X25519', mode === 'encrypted', ['deriveBits']);
  if (mode === 'native') return pair;
  // Finish fallible setup before exporting private bytes. Promise.all rejection
  // must never strand a successful private export outside its cleanup scope.
  const [publicRaw, wrappingKey] = await Promise.all([
    crypto.subtle.exportKey('raw', pair.publicKey),
    crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
  ]);
  const publicKeyRaw = toBase64Url(new Uint8Array(publicRaw));
  const context = contextFor(burrowId, publicKeyRaw);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const clear = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  try {
    const ciphertext = await crypto.subtle.encrypt({
      name: 'AES-GCM', iv, additionalData: encoder.encode(context),
    }, wrappingKey, clear);
    const privateKey = await crypto.subtle.importKey('pkcs8', clear, 'X25519', false, ['deriveBits']);
    envelopes.set(privateKey, { format: 'aes-gcm-x25519-v1', wrappingKey, iv, ciphertext, context });
    return { privateKey, publicKey: pair.publicKey };
  } finally {
    // Best effort only: JavaScript/WebCrypto may retain internal copies.
    clear.fill(0);
  }
}

export function storePocketPrivateKey(key: CryptoKey): StoredPocketPrivateKey {
  validatePrivateKey(key);
  return envelopes.get(key) ?? key;
}

function validatePrivateKey(key: CryptoKey): void {
  if (key?.type !== 'private' || key.extractable !== false ||
    key.algorithm?.name !== 'X25519' || !key.usages.includes('deriveBits')) {
    throw new Error('Invalid Pocket private key');
  }
}

export async function loadPocketPrivateKey(
  stored: StoredPocketPrivateKey, burrowId: string, publicKeyRaw: string,
): Promise<CryptoKey> {
  if (!stored || !('format' in stored)) {
    validatePrivateKey(stored as CryptoKey);
    return stored as CryptoKey;
  }
  if (stored.format !== 'aes-gcm-x25519-v1' ||
    stored.context !== contextFor(burrowId, publicKeyRaw) ||
    stored.wrappingKey?.type !== 'secret' || stored.wrappingKey.extractable !== false ||
    stored.wrappingKey.algorithm.name !== 'AES-GCM' ||
    (stored.wrappingKey.algorithm as AesKeyAlgorithm).length !== 256 ||
    !(stored.iv instanceof Uint8Array) || stored.iv.byteLength !== 12) {
    throw new Error('Invalid encrypted Pocket private key');
  }
  const clear = new Uint8Array(await crypto.subtle.decrypt({
    name: 'AES-GCM', iv: stored.iv, additionalData: encoder.encode(stored.context),
  }, stored.wrappingKey, stored.ciphertext));
  try {
    const key = await crypto.subtle.importKey('pkcs8', clear, 'X25519', false, ['deriveBits']);
    envelopes.set(key, stored);
    return key;
  } finally { clear.fill(0); }
}
