import { HARNESS_VERSION, environment, bounded, request, openDb } from './capabilities.js';

// This fixed diagnostic-only database retains one disposable checkpoint until
// explicit cleanup. Never open Pocket's authorization database or export keys.
const DATABASE = 'dormouse-capability-probe-restart-v1';
const PAGE = crypto.randomUUID();
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const equal = (a, b) => {
  const x = new Uint8Array(a), y = new Uint8Array(b);
  assert(x.length === y.length && x.every((v, i) => v === y[i]), 'Recovered key produced a different shared secret');
};

async function read() {
  const db = await openDb(DATABASE);
  try { return await bounded(request(db.transaction('inline').objectStore('inline').get('test'))); }
  finally { db.close(); }
}

async function write(record) {
  const db = await openDb(DATABASE);
  try {
    const tx = db.transaction('inline', 'readwrite');
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('Checkpoint transaction aborted'));
    });
    try {
      tx.objectStore('inline').put(record);
      await bounded(done, () => { try { tx.abort(); } catch {} });
    } catch (error) {
      try { tx.abort(); } catch {}
      await done.catch(() => {});
      throw error;
    }
  } finally { db.close(); }
}

export async function prepareRestart() {
  assert(!(await read()), 'A checkpoint already exists. Verify it or remove test data before preparing another.');
  const aes = await bounded(crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
  // Extractability is confined to a disposable, never-authorized test key.
  const pair = await bounded(crypto.subtle.generateKey('X25519', true, ['deriveBits']));
  const peer = await bounded(crypto.subtle.generateKey('X25519', false, ['deriveBits']));
  const expected = await bounded(crypto.subtle.deriveBits({ name: 'X25519', public: peer.publicKey }, pair.privateKey, 256));
  const peerPublic = await bounded(crypto.subtle.exportKey('raw', peer.publicKey));
  const clear = new Uint8Array(await bounded(crypto.subtle.exportKey('pkcs8', pair.privateKey)));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  let ciphertext;
  try { ciphertext = await bounded(crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, clear)); }
  finally { clear.fill(0); }
  const record = { id: 'test', schema: 1, page: PAGE, preparedAt: new Date().toISOString(),
    preparedEnvironment: environment(), aes, iv, ciphertext, peerPublic, expected };
  await write(record);
  return { status: 'PREPARED', preparedAt: record.preparedAt, environment: record.preparedEnvironment };
}

export async function verifyRestart() {
  const report = { version: HARNESS_VERSION, test: 'encrypted-x25519-restart',
    at: new Date().toISOString(), environment: environment(),
    restartEvidence: 'A new page instance is detectable; force-quit or OS restart requires user confirmation.' };
  let stage = 'read-checkpoint';
  try {
    const saved = await read();
    assert(saved != null, 'No checkpoint found in this browser/app. Prepare it here before closing this app; Safari and Home Screen storage may differ.');
    assert(saved.schema === 1, 'Unknown checkpoint format');
    report.preparedAt = saved.preparedAt;
    report.preparedEnvironment = saved.preparedEnvironment;
    report.newPageInstance = saved.page !== PAGE;
    stage = 'check-new-page';
    assert(report.newPageInstance, 'This is still the page that prepared the checkpoint. Close and reopen the app; if it resumes this page, use Reload test page.');
    stage = 'validate-aes';
    assert(saved.aes?.type === 'secret' && saved.aes.extractable === false &&
      saved.aes.algorithm?.name === 'AES-GCM', 'Stored AES key is missing, extractable, or invalid');
    stage = 'decrypt';
    const clear = new Uint8Array(await bounded(crypto.subtle.decrypt({ name: 'AES-GCM', iv: saved.iv }, saved.aes, saved.ciphertext)));
    let key;
    try {
      stage = 'import-x25519';
      key = await bounded(crypto.subtle.importKey('pkcs8', clear, 'X25519', false, ['deriveBits']));
    } finally { clear.fill(0); }
    assert(key.type === 'private' && key.extractable === false, 'Recovered private key is invalid');
    stage = 'derive-and-compare';
    const peer = await bounded(crypto.subtle.importKey('raw', saved.peerPublic, 'X25519', false, []));
    equal(await bounded(crypto.subtle.deriveBits({ name: 'X25519', public: peer }, key, 256)), saved.expected);
    return { ...report, status: 'PASS', retained: true };
  } catch (error) {
    return { ...report, status: 'FAIL', stage, error: `${error.name}: ${error.message}`, retained: true };
  }
}

export async function clearRestart() {
  await bounded(request(indexedDB.deleteDatabase(DATABASE)));
  return { status: 'REMOVED', test: 'encrypted-x25519-restart' };
}
