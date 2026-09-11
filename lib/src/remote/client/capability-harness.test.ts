import { webcrypto } from 'node:crypto';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// Public diagnostic module is intentionally standalone and browser-native.
// @ts-ignore JavaScript artifact has no separate type declaration.
import { commit, request, runCapabilities } from '../../../pocket/public/diagnostics/capabilities.js';

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('navigator', { userAgent: 'Node control (not iOS)' });
  for (const storage of ['localStorage', 'sessionStorage']) {
    const values = new Map();
    vi.stubGlobal(storage, {
      setItem: (key: string, value: string) => values.set(key, value),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
    });
  }
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// @ts-ignore Browser-native diagnostic module.
const restartModule = () => import('../../../pocket/public/diagnostics/restart.js');

it('retains an isolated checkpoint, rejects same-page verification, and recovers after module restart', async () => {
  vi.resetModules();
  const first = await restartModule();
  expect(await first.prepareRestart()).toMatchObject({ status: 'PREPARED' });
  expect(await first.verifyRestart()).toMatchObject({ status: 'FAIL', stage: 'check-new-page' });
  await expect(first.prepareRestart()).rejects.toThrow('already exists');
  vi.resetModules();
  const second = await restartModule();
  const report = await second.verifyRestart();
  expect(report).toMatchObject({ status: 'PASS', newPageInstance: true, retained: true });
  expect(JSON.stringify(report)).not.toMatch(/ciphertext|peerPublic|expected|privateKey/);
  expect(await second.verifyRestart()).toMatchObject({ status: 'PASS' });
  expect(await indexedDB.databases()).toEqual([{ name: 'dormouse-capability-probe-restart-v1', version: 1 }]);
  await second.clearRestart();
  expect(await indexedDB.databases()).toEqual([]);
  expect(await second.verifyRestart()).toMatchObject({ status: 'FAIL', stage: 'read-checkpoint' });
  await second.clearRestart();
});

it('fails closed when a retained checkpoint ciphertext is corrupted', async () => {
  vi.resetModules();
  const first = await restartModule();
  await first.prepareRestart();
  const db: IDBDatabase = await request(indexedDB.open('dormouse-capability-probe-restart-v1'));
  const tx = db.transaction('inline', 'readwrite');
  const store = tx.objectStore('inline');
  const saved = await request(store.get('test'));
  await commit(tx, () => {
    new Uint8Array(saved.ciphertext)[0] ^= 1;
    store.put(saved);
  });
  db.close();
  vi.resetModules();
  const second = await restartModule();
  expect(await second.verifyRestart()).toMatchObject({ status: 'FAIL', stage: 'decrypt' });
  await second.clearRestart();
});

it('runs real crypto operations, including encrypted X25519, without touching Pocket state', async () => {
  const open = vi.spyOn(indexedDB, 'open');
  const report = await runCapabilities();
  expect(report.results).toHaveLength(21);
  expect(report.results.filter((row: { status: string }) => row.status !== 'PASS')).toEqual([]);
  expect(report.cleanupErrors).toEqual([]);
  expect(open.mock.calls.every(([name]) => name.startsWith('dormouse-capability-probe-'))).toBe(true);
  expect(await indexedDB.databases()).toEqual([]);
});

it('continues after simulated WebKit X25519 failures and distinguishes missing readback', async () => {
  const put = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (value, key) {
    if (value?.key?.algorithm?.name === 'X25519') throw new DOMException('clone failed', 'DataError');
    if (value?.algorithm?.name === 'X25519') return put.call(this, null, key);
    return put.call(this, value, key);
  });
  const report = await runCapabilities();
  const byId = (id: string) => report.results.find((row: { id: string }) => row.id === id);
  expect(byId('X25519-inline')).toMatchObject({ status: 'FAIL', stage: 'write' });
  expect(byId('X25519-explicit')).toMatchObject({ status: 'FAIL', stage: 'validate' });
  expect(byId('encrypted-x25519')).toMatchObject({ status: 'PASS' });
  expect(await indexedDB.databases()).toEqual([]);
});
