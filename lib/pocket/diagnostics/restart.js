import {
  HARNESS_VERSION, assert, bounded, commit, environment, equal, message, openDb, request,
} from './capabilities.js';
import { toBase64Url } from 'remote-lib-common';
import {
  generatePocketKeyPair, loadPocketPrivateKey, storePocketPrivateKey,
} from '../../src/remote/client/pocket-private-key';

// This fixed diagnostic-only database retains one disposable checkpoint until
// explicit cleanup. Never open Pocket's authorization database or export keys.
const DATABASE = 'dormouse-capability-probe-restart-v1';
const PAGE = crypto.randomUUID();
async function read() {
  const db = await openDb(DATABASE);
  try { return await bounded(request(db.transaction('inline').objectStore('inline').get('test'))); }
  finally { db.close(); }
}

async function write(record) {
  const db = await openDb(DATABASE);
  try {
    const tx = db.transaction('inline', 'readwrite');
    await commit(tx, () => tx.objectStore('inline').put(record), 'Checkpoint transaction aborted');
  } finally { db.close(); }
}

export async function prepareRestart() {
  assert(!(await read()), 'A checkpoint already exists. Verify it or remove test data before preparing another.');
  const pair = await bounded(generatePocketKeyPair('encrypted', 'diagnostic-restart'));
  const publicKeyRaw = toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  const peer = await bounded(crypto.subtle.generateKey('X25519', false, ['deriveBits']));
  const expected = await bounded(crypto.subtle.deriveBits({ name: 'X25519', public: peer.publicKey }, pair.privateKey, 256));
  const peerPublic = await bounded(crypto.subtle.exportKey('raw', peer.publicKey));
  const record = { id: 'test', schema: 2, page: PAGE, preparedAt: new Date().toISOString(),
    preparedEnvironment: environment(), envelope: storePocketPrivateKey(pair.privateKey),
    publicKeyRaw, peerPublic, expected };
  await write(record);
  return { status: 'PREPARED', preparedAt: record.preparedAt, environment: record.preparedEnvironment };
}

export async function verifyRestart() {
  const report = { version: HARNESS_VERSION, test: 'encrypted-x25519-restart',
    format: 'aes-gcm-x25519-v1', authenticatedContext: true,
    at: new Date().toISOString(), environment: environment(),
    restartEvidence: 'A new page instance is detectable; force-quit or OS restart requires user confirmation.' };
  let stage = 'read-checkpoint';
  try {
    const saved = await read();
    assert(saved != null, 'No checkpoint found in this browser/app. Prepare it here before closing this app; Safari and Home Screen storage may differ.');
    assert(saved.schema === 2, 'Legacy or unknown checkpoint: remove test data and prepare a new production-format test.');
    report.preparedAt = saved.preparedAt;
    report.preparedEnvironment = saved.preparedEnvironment;
    report.newPageInstance = saved.page !== PAGE;
    stage = 'check-new-page';
    assert(report.newPageInstance, 'This is still the page that prepared the checkpoint. Close and reopen the app; if it resumes this page, use Reload test page.');
    stage = 'restore-production-key';
    const key = await bounded(loadPocketPrivateKey(saved.envelope, 'diagnostic-restart', saved.publicKeyRaw));
    assert(key.type === 'private' && key.extractable === false, 'Recovered private key is invalid');
    stage = 'derive-and-compare';
    const peer = await bounded(crypto.subtle.importKey('raw', saved.peerPublic, 'X25519', false, []));
    equal(await bounded(crypto.subtle.deriveBits({ name: 'X25519', public: peer }, key, 256)),
      saved.expected, 'Recovered key produced a different shared secret');
    return { ...report, status: 'PASS', retained: true };
  } catch (error) {
    return { ...report, status: 'FAIL', stage, error: message(error), retained: true };
  }
}

export async function clearRestart() {
  await bounded(request(indexedDB.deleteDatabase(DATABASE)));
  return { status: 'REMOVED', test: 'encrypted-x25519-restart' };
}
