import { webcrypto } from 'node:crypto';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fromBase64Url, generateNoiseKeyPair, sealPush, toBase64Url, utf8Encode } from 'remote-lib-common';
import {
  indexedDbKnownBurrowStore, promisifyRequest, requirePocketKeyStorage, withPocketStore,
  invalidatePocketKeyStorage,
  KNOWN_BURROWS_STORE, POCKET_KEY_STORAGE_ERROR, type KnownBurrowV1,
} from './pocket-db';
import { generatePocketKeyPair, loadPocketPrivateKey, storePocketPrivateKey } from './pocket-private-key';
import { makeE2eHarness } from './test-e2e-harness';
import { installPocketWorker, type WorkerScope } from '../pocket-app/sw';

it('does not export private bytes if parallel wrapping-key setup fails', async () => {
  const generate = crypto.subtle.generateKey.bind(crypto.subtle);
  const exportKey = vi.spyOn(crypto.subtle, 'exportKey');
  vi.spyOn(crypto.subtle, 'generateKey').mockImplementation((algorithm, extractable, usages) => {
    if (typeof algorithm === 'object' && algorithm.name === 'AES-GCM') {
      return Promise.reject(new Error('AES unavailable'));
    }
    return generate(algorithm, extractable, usages);
  });
  await expect(generatePocketKeyPair('encrypted', 'probe')).rejects.toThrow('AES unavailable');
  expect(exportKey.mock.calls.some(([format]) => format === 'pkcs8')).toBe(false);
});

it.each(['encrypt', 'importKey'] as const)('clears exported private bytes when %s fails', async operation => {
  const original = crypto.subtle.exportKey.bind(crypto.subtle);
  let clear: Uint8Array | undefined;
  vi.spyOn(crypto.subtle, 'exportKey').mockImplementation(async (format, key) => {
    const result = await original(format, key);
    if (format === 'pkcs8') clear = new Uint8Array(result as ArrayBuffer);
    return result;
  });
  vi.spyOn(crypto.subtle, operation).mockRejectedValue(new Error('injected failure'));
  await expect(generatePocketKeyPair('encrypted', 'probe')).rejects.toThrow('injected failure');
  expect(clear?.byteLength).toBeGreaterThan(0);
  expect(clear?.every(byte => byte === 0)).toBe(true);
});

it('shares one successful probe across concurrent scans, but probes again in a fresh module', async () => {
  const open = vi.spyOn(indexedDB, 'open');
  await Promise.all([requirePocketKeyStorage(), requirePocketKeyStorage(), requirePocketKeyStorage()]);
  expect(open).toHaveBeenCalledTimes(2);
  await requirePocketKeyStorage();
  expect(open).toHaveBeenCalledTimes(2);
  vi.resetModules();
  const fresh = await import('./pocket-db');
  await fresh.requirePocketKeyStorage();
  expect(open).toHaveBeenCalledTimes(4);
});

it('does not memoize failure and invalidates successful evidence on a store failure', async () => {
  const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
    throw new DOMException('injected failure', 'QuotaExceededError');
  });
  await expect(requirePocketKeyStorage()).rejects.toThrow('Encrypted storage:');
  put.mockRestore();
  await requirePocketKeyStorage();
  const open = vi.spyOn(indexedDB, 'open');
  await expect(withPocketStore(KNOWN_BURROWS_STORE, 'readonly', async () => {
    throw new DOMException('injected failure', 'UnknownError');
  })).rejects.toThrow();
  open.mockClear();
  await requirePocketKeyStorage();
  expect(open).toHaveBeenCalledTimes(2);
});

it('does not let an invalidated in-flight probe authorize a scan', async () => {
  const checking = requirePocketKeyStorage();
  invalidatePocketKeyStorage();
  await expect(checking).rejects.toThrow('Pairing has not started');
  await expect(requirePocketKeyStorage()).resolves.toBeUndefined();
});

it('invalidates cached compatibility when opening the production database fails', async () => {
  await requirePocketKeyStorage();
  const open = vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => {
    throw new DOMException('storage denied', 'SecurityError');
  });
  await expect(indexedDbKnownBurrowStore().listSummaries()).rejects.toThrow('storage denied');
  open.mockRestore();
  const retried = vi.spyOn(indexedDB, 'open');
  await requirePocketKeyStorage();
  expect(retried).toHaveBeenCalledTimes(2);
});

it('lists and removes a paired record without decrypting its corrupt key', async () => {
  breakNativeStorage();
  const store = indexedDbKnownBurrowStore();
  const harness = await makeE2eHarness({ deps: { knownBurrows: store } });
  try {
    expect(await harness.pairAndApprove(await harness.mintInvitation())).toMatchObject({ ok: true });
    const raw = await rawRecord(harness.burrowId);
    raw.clientStaticKeyPair.privateKey.ciphertext = new ArrayBuffer(16);
    await withPocketStore(KNOWN_BURROWS_STORE, 'readwrite', async target => {
      await promisifyRequest(target.put(raw));
    });
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
    const importKey = vi.spyOn(crypto.subtle, 'importKey');
    const summaries = await harness.client.listKnownBurrows();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).not.toHaveProperty('clientStaticKeyPair');
    expect(await store.getSummary(harness.burrowId)).toEqual(summaries[0]);
    await harness.client.forgetBurrow(harness.burrowId);
    expect(await store.listSummaries()).toEqual([]);
    expect(decrypt).not.toHaveBeenCalled();
    expect(importKey).not.toHaveBeenCalled();
  } finally { harness.client.close(); harness.burrow.stop(); }
});

it('re-pairs a damaged envelope only after approval, preserving the Burrow pin and retiring the old delivery id', async () => {
  breakNativeStorage();
  const store = indexedDbKnownBurrowStore();
  const harness = await makeE2eHarness({ deps: { knownBurrows: store } });
  try {
    expect(await harness.pairAndApprove(await harness.mintInvitation())).toMatchObject({ ok: true });
    const raw = await rawRecord(harness.burrowId);
    const oldPublic = raw.clientStaticKeyPair.publicKeyRaw;
    const oldDelivery = raw.authorization.deliveryId;
    raw.clientStaticKeyPair.privateKey.ciphertext = new ArrayBuffer(16);
    await withPocketStore(KNOWN_BURROWS_STORE, 'readwrite', async target => {
      await promisifyRequest(target.put(raw));
    });
    await expect(store.get(harness.burrowId)).rejects.toThrow();
    expect((await rawRecord(harness.burrowId)).clientStaticKeyPair.publicKeyRaw).toBe(oldPublic);

    expect(await harness.pairAndApprove(await harness.mintInvitation())).toMatchObject({ ok: true });
    const restored = (await store.get(harness.burrowId))!;
    expect(restored.burrowStaticPublicKey).toBe(raw.burrowStaticPublicKey);
    expect(restored.clientStaticKeyPair.publicKeyRaw).not.toBe(oldPublic);
    expect(await harness.pendingDeletions.list()).toContainEqual(expect.objectContaining({ deliveryId: oldDelivery }));
    await harness.client.retirePendingDeletions();
    expect(harness.calls.some(call => call.method === 'DELETE' && call.url.endsWith(oldDelivery))).toBe(true);
    expect(await harness.client.connect(harness.burrowId)).toMatchObject({ ok: true });
  } finally { harness.client.close(); harness.burrow.stop(); }
});

beforeEach(() => {
  invalidatePocketKeyStorage();
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('indexedDB', new IDBFactory());
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function breakNativeStorage() {
  const put = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (value, key) {
    if (value?.clientStaticKeyPair?.privateKey?.algorithm?.name === 'X25519') {
      throw new DOMException('WebKit clone failure', 'DataError');
    }
    if (value?.algorithm?.name === 'X25519') return put.call(this, null, key);
    return put.call(this, value, key);
  });
}

async function rawRecord(burrowId: string): Promise<any> {
  return withPocketStore(KNOWN_BURROWS_STORE, 'readonly', store => promisifyRequest(store.get(burrowId)));
}

it('prefers native storage when it works and never exports a private key', async () => {
  const exportKey = vi.spyOn(crypto.subtle, 'exportKey');
  await requirePocketKeyStorage();
  const pair = await indexedDbKnownBurrowStore().generateKey('burrow');
  expect(pair.privateKey.extractable).toBe(false);
  expect(storePocketPrivateKey(pair.privateKey as CryptoKey)).toBe(pair.privateKey);
  expect(exportKey.mock.calls.every(([format]) => format === 'raw')).toBe(true);
});

it('blocks pairing when neither key encoding survives storage', async () => {
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
    throw new DOMException('secret detail', 'QuotaExceededError');
  });
  const failure = await requirePocketKeyStorage().catch((error: Error) => error);
  expect(failure.message).toContain('Encrypted storage:');
  // Both probes failed, and the sentence the user reads says so once, not twice.
  expect(failure.message.split(POCKET_KEY_STORAGE_ERROR)).toHaveLength(2);
  await expect(indexedDbKnownBurrowStore().generateKey('burrow')).rejects.toThrow('Pairing has not started');
});

it('rejects silent loss of the encrypted wrapping key during the preflight', async () => {
  const put = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (value, key) {
    if (value?.clientStaticKeyPair?.privateKey?.format) {
      const changed = structuredClone(value);
      changed.clientStaticKeyPair.privateKey.wrappingKey = null;
      return put.call(this, changed, key);
    }
    if (value?.clientStaticKeyPair?.privateKey?.algorithm?.name === 'X25519') {
      throw new DOMException('clone failed', 'DataError');
    }
    return put.call(this, value, key);
  });
  await expect(requirePocketKeyStorage()).rejects.toThrow('Encrypted storage:');
});

it('does not persist an encrypted identity when the laptop denies pairing', async () => {
  breakNativeStorage();
  await requirePocketKeyStorage();
  const store = indexedDbKnownBurrowStore();
  const harness = await makeE2eHarness({ deps: { knownBurrows: store } });
  try {
    const result = await harness.pairAndApprove(await harness.mintInvitation(), {
      code: shown => shown === '00' ? '01' : '00',
    });
    expect(result.ok).toBe(false);
    expect(await store.list()).toEqual([]);
  } finally { harness.client.close(); harness.burrow.stop(); }
});

it('pairs, reconnects after fresh module load, and decrypts worker push with the encrypted record', async () => {
  breakNativeStorage();
  await requirePocketKeyStorage();
  const store = indexedDbKnownBurrowStore();
  const harness = await makeE2eHarness({ deps: { knownBurrows: store } });
  try {
    expect(await harness.pairAndApprove(await harness.mintInvitation())).toMatchObject({ ok: true });
    const raw = await rawRecord(harness.burrowId);
    expect(raw.clientStaticKeyPair.privateKey).toMatchObject({
      format: 'aes-gcm-x25519-v1', wrappingKey: { extractable: false },
    });
    expect(raw.clientStaticKeyPair.privateKey.algorithm).toBeUndefined();
    expect(await harness.client.connect(harness.burrowId)).toMatchObject({ ok: true });
    harness.client.close();

    // Drop module-local key/envelope maps. A worker or new page must recover
    // using IndexedDB alone, not an in-memory association.
    vi.resetModules();
    const reloaded = await import('./pocket-db');
    const freshStore = reloaded.indexedDbKnownBurrowStore();
    const record = (await freshStore.get(harness.burrowId))!;
    expect(record.clientStaticKeyPair.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', record.clientStaticKeyPair.privateKey)).rejects.toThrow();
    const newHarness = await makeE2eHarness({
      burrowId: harness.burrowId, authenticator: harness.authenticator,
      noiseStatic: harness.noiseStatic, loadAcl: () => harness.savedAcl,
      deps: { knownBurrows: freshStore },
    });
    try { expect(await newHarness.client.connect(harness.burrowId)).toMatchObject({ ok: true }); }
    finally { newHarness.client.close(); newHarness.burrow.stop(); }

    const burrowKey = await crypto.subtle.importKey('pkcs8',
      new Uint8Array(fromBase64Url(harness.noiseStatic.privateKeyPkcs8)), 'X25519', false, ['deriveBits']);
    const sealed = await sealPush({
      burrowStaticPrivateKey: burrowKey,
      clientStaticPublicKey: fromBase64Url(record.clientStaticKeyPair.publicKeyRaw),
      plaintext: utf8Encode(JSON.stringify({ title: 'Saved key works', body: 'Worker decrypted', tag: 'test' })),
    });
    const listeners = new Map<string, any>();
    const showNotification = vi.fn(async () => {});
    installPocketWorker({
      addEventListener: (type: string, listener: unknown) => listeners.set(type, listener),
      skipWaiting: () => {}, clients: { claim: async () => {}, matchAll: async () => [] },
      registration: { showNotification },
    } as unknown as WorkerScope, freshStore);
    let work: Promise<unknown> = Promise.resolve();
    listeners.get('push')({
      data: { json: () => ({ burrowId: harness.burrowId, ...sealed }) },
      waitUntil: (promise: Promise<unknown>) => { work = promise; },
    });
    await work;
    expect(showNotification).toHaveBeenCalledWith('Saved key works', expect.objectContaining({ body: 'Worker decrypted' }));
    await freshStore.put({ ...record, authorization: { state: 'pairing-required' } });
    expect((await rawRecord(harness.burrowId)).clientStaticKeyPair.privateKey.format).toBe('aes-gcm-x25519-v1');
    expect((await freshStore.list())[0]!.authorization.state).toBe('pairing-required');
    await freshStore.delete(harness.burrowId);
    expect(await freshStore.list()).toEqual([]);
  } finally { harness.client.close(); harness.burrow.stop(); }
});

it('rejects ciphertext damage, wrong Burrow/public context, unknown formats, and extractable wrapping keys', async () => {
  const pair = await generatePocketKeyPair('encrypted', 'burrow');
  const publicRaw = toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  const envelope = storePocketPrivateKey(pair.privateKey);
  if (!('format' in envelope)) throw new Error('Expected encrypted envelope');
  const another = storePocketPrivateKey((await generatePocketKeyPair('encrypted', 'other')).privateKey);
  if (!('format' in another)) throw new Error('Expected second envelope');
  expect(another.wrappingKey).not.toBe(envelope.wrappingKey);
  expect(another.iv).not.toEqual(envelope.iv);
  await expect(crypto.subtle.exportKey('raw', envelope.wrappingKey)).rejects.toThrow();
  await expect(loadPocketPrivateKey(envelope, 'other', publicRaw)).rejects.toThrow();
  await expect(loadPocketPrivateKey(envelope, 'burrow', 'wrong')).rejects.toThrow();
  const damaged = structuredClone(envelope);
  new Uint8Array(damaged.ciphertext)[0] ^= 1;
  await expect(loadPocketPrivateKey(damaged, 'burrow', publicRaw)).rejects.toThrow();
  await expect(loadPocketPrivateKey({ ...envelope, format: 'unknown' } as any, 'burrow', publicRaw)).rejects.toThrow();
  const wrappingKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  await expect(loadPocketPrivateKey({ ...envelope, wrappingKey }, 'burrow', publicRaw)).rejects.toThrow();
});

it('keeps legacy native records usable without changing their encoding', async () => {
  const pair = await generateNoiseKeyPair();
  const record: KnownBurrowV1 = {
    burrowId: 'legacy', accountId: 'owner', label: 'Laptop', burrowStaticPublicKey: 'pin',
    clientStaticKeyPair: { privateKey: pair.privateKey as CryptoKey, publicKeyRaw: toBase64Url(pair.publicKey) },
    passkeyCredentialId: 'cred', passkeyPublicKeyHash: 'hash', authorization: { state: 'pairing-required' },
  };
  const store = indexedDbKnownBurrowStore();
  await store.put(record);
  const restored = (await store.get('legacy'))!;
  expect(restored.clientStaticKeyPair.privateKey.algorithm.name).toBe('X25519');
  await store.put(restored);
  expect((await rawRecord('legacy')).clientStaticKeyPair.privateKey.algorithm.name).toBe('X25519');
});
