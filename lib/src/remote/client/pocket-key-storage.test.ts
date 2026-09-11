import { webcrypto } from 'node:crypto';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { probePocketKeyStorage as requirePocketKeyStorage } from './pocket-db';

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('indexedDB', new IDBFactory());
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('round-trips and uses a real nonextractable key, then deletes only its probe database', async () => {
  const open = vi.spyOn(indexedDB, 'open');
  const remove = vi.spyOn(indexedDB, 'deleteDatabase');
  await requirePocketKeyStorage();
  expect(open).toHaveBeenCalledTimes(2);
  const name = open.mock.calls[0]![0];
  expect(name).toMatch(/^dormouse-pocket-key-probe-/);
  expect(open.mock.calls[1]![0]).toBe(name);
  expect(remove).toHaveBeenCalledExactlyOnceWith(name);
});

it('reports a rejected key clone before pairing, and cleans up', async () => {
  const remove = vi.spyOn(indexedDB, 'deleteDatabase');
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
    throw new DOMException('Key path did not yield a value', 'DataError');
  });
  await expect(requirePocketKeyStorage()).rejects.toThrow('Diagnostic: write-record / DataError.');
  expect(remove).toHaveBeenCalledOnce();
});

it('rejects a successful write whose private key does not survive readback', async () => {
  const put = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (value) {
    return put.call(this, { ...value, clientStaticKeyPair: { privateKey: null } });
  });
  await expect(requirePocketKeyStorage()).rejects.toThrow('Diagnostic: validate-record / Error.');
});

it('rejects a readback key that derives the wrong secret', async () => {
  const other = await crypto.subtle.generateKey('X25519', false, ['deriveBits']);
  const put = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (value) {
    return put.call(this, { ...value, clientStaticKeyPair: { privateKey: other.privateKey } });
  });
  await expect(requirePocketKeyStorage()).rejects.toThrow('Diagnostic: compare-key-agreement / Error.');
});

it('identifies read failures without echoing browser error contents', async () => {
  vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(() => {
    throw new DOMException('private browser details', 'UnknownError');
  });
  const error = await requirePocketKeyStorage().catch(error => error as Error);
  expect(error.message).toContain('Diagnostic: read-record / UnknownError.');
  expect(error.message).not.toContain('private browser details');
});

it('distinguishes generation failure from storage failure', async () => {
  vi.spyOn(crypto.subtle, 'generateKey').mockRejectedValue(new DOMException('unsupported', 'NotSupportedError'));
  await expect(requirePocketKeyStorage()).rejects.toThrow('Diagnostic: generate-key / NotSupportedError.');
});

it('allows a fresh retry after a storage failure', async () => {
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => {
    throw new DOMException('Storage unavailable', 'DataError');
  });
  await expect(requirePocketKeyStorage()).rejects.toThrow('Diagnostic: write-record / DataError.');
  await expect(requirePocketKeyStorage()).resolves.toBeUndefined();
});
