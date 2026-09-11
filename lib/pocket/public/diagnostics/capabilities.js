// Diagnostic databases are independent of Pocket's authorization database.
export const HARNESS_VERSION = '2';
const PREFIX = 'dormouse-capability-probe-';
const LIMIT = 8000;
const message = error => `${error?.name || 'Error'}: ${error?.message || 'failed'}`;
const assert = (ok, reason) => { if (!ok) throw new Error(reason); };
const equal = (a, b) => {
  const x = new Uint8Array(a), y = new Uint8Array(b);
  assert(x.length === y.length && x.every((v, i) => v === y[i]), 'Key operation produced a different result');
};

export function bounded(operation, cleanup = () => {}) {
  let timer;
  return Promise.race([
    operation,
    new Promise((_, reject) => { timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out after 8 seconds'));
    }, LIMIT); }),
  ]).finally(() => clearTimeout(timer));
}

export function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function openDb(name) {
  const req = indexedDB.open(name, 1);
  let abandoned = false;
  req.onupgradeneeded = () => {
    req.result.createObjectStore('inline', { keyPath: 'id' });
    req.result.createObjectStore('explicit');
  };
  const promise = new Promise((resolve, reject) => {
    req.onsuccess = () => {
      if (abandoned) { req.result.close(); return; }
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => { abandoned = true; reject(new Error('Diagnostic database open blocked')); };
  });
  return bounded(promise, () => { abandoned = true; });
}

async function roundTrip(value, inline, phase, cleanupErrors) {
  const name = PREFIX + crypto.randomUUID();
  let db;
  try {
    phase('open');
    db = await openDb(name);
    phase('write');
    const storeName = inline ? 'inline' : 'explicit';
    const tx = db.transaction(storeName, 'readwrite');
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('Transaction aborted'));
    });
    try {
      const store = tx.objectStore(storeName);
      if (inline) store.put(value); else store.put(value, 'test');
      phase('commit');
      await bounded(done, () => { try { tx.abort(); } catch {} });
    } catch (error) {
      try { tx.abort(); } catch {}
      await done.catch(() => {});
      throw error;
    }
    phase('reopen');
    db.close();
    db = await openDb(name);
    phase('read');
    const saved = await bounded(request(db.transaction(storeName).objectStore(storeName).get('test')));
    phase('validate');
    assert(saved != null, 'Readback returned null or undefined');
    return saved;
  } finally {
    db?.close();
    try { await bounded(request(indexedDB.deleteDatabase(name))); }
    catch (error) { cleanupErrors.push(message(error)); }
  }
}

function validateKey(key, type, algorithm) {
  assert(key?.type === type, 'Readback key has the wrong type or is missing');
  assert(key.extractable === false, 'Readback private/secret key is extractable');
  assert(key.algorithm?.name === algorithm, 'Readback key has the wrong algorithm');
}

async function exercise(algorithm, key, pair) {
  const data = new Uint8Array([1, 3, 5, 7]);
  if (algorithm === 'AES-GCM') {
    const params = { name: algorithm, iv: crypto.getRandomValues(new Uint8Array(12)) };
    const ciphertext = await crypto.subtle.encrypt(params, key, data);
    equal(await crypto.subtle.decrypt(params, pair, ciphertext), data);
  } else if (algorithm === 'X25519') {
    const params = { name: algorithm, public: pair.publicKey };
    equal(await crypto.subtle.deriveBits(params, key, 256),
      await crypto.subtle.deriveBits(params, pair.privateKey, 256));
  } else {
    const params = algorithm === 'ECDSA' ? { name: algorithm, hash: 'SHA-256' } : algorithm;
    const signature = await crypto.subtle.sign(params, key, data);
    assert(await crypto.subtle.verify(params, pair.publicKey, signature, data), 'Stored key signature did not verify');
  }
}

function generate(algorithm) {
  if (algorithm === 'AES-GCM') return crypto.subtle.generateKey({ name: algorithm, length: 256 }, false, ['encrypt', 'decrypt']);
  if (algorithm === 'ECDSA') return crypto.subtle.generateKey({ name: algorithm, namedCurve: 'P-256' }, false, ['sign', 'verify']);
  return crypto.subtle.generateKey(algorithm, false, algorithm === 'X25519' ? ['deriveBits'] : ['sign', 'verify']);
}

export function environment() {
  return {
    userAgent: navigator.userAgent,
    secureContext: globalThis.isSecureContext === true,
    displayMode: globalThis.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true ? 'standalone' : 'browser',
    apiPresenceOnly: {
      webCrypto: !!globalThis.crypto?.subtle, indexedDB: typeof indexedDB !== 'undefined',
      structuredClone: typeof structuredClone === 'function',
      webAuthn: typeof PublicKeyCredential !== 'undefined',
      serviceWorker: 'serviceWorker' in navigator, pushManager: typeof PushManager !== 'undefined',
      notificationPermission: typeof Notification === 'undefined' ? 'unavailable' : Notification.permission,
      camera: !!navigator.mediaDevices?.getUserMedia,
      webRTC: typeof RTCPeerConnection !== 'undefined', clipboard: !!navigator.clipboard?.writeText,
      persistentStorage: !!navigator.storage?.persist,
    },
  };
}

export async function runCapabilities(onResult = () => {}) {
  const report = { version: HARNESS_VERSION, at: new Date().toISOString(), environment: environment(), results: [], cleanupErrors: [] };
  const check = async (id, label, operation) => {
    let stage = 'start';
    const phase = next => { stage = next; };
    const started = performance.now();
    let result;
    try { await operation(phase); result = { id, label, status: 'PASS' }; }
    catch (error) { result = { id, label, status: 'FAIL', stage, error: message(error) }; }
    result.ms = Math.round(performance.now() - started);
    report.results.push(result);
    onResult(result);
  };
  for (const name of ['localStorage', 'sessionStorage']) {
    await check(name, `${name}: disposable text round trip`, async phase => {
      const id = PREFIX + crypto.randomUUID();
      phase('write/read');
      try { globalThis[name].setItem(id, 'test'); assert(globalThis[name].getItem(id) === 'test', 'Readback mismatch'); }
      finally { globalThis[name].removeItem(id); }
    });
  }
  for (const inline of [true, false]) {
    await check(`plain-${inline}`, `IndexedDB: plain record, ${inline ? 'inline' : 'explicit'} key`, async phase => {
      const saved = await roundTrip({ id: 'test', value: 'ok' }, inline, phase, report.cleanupErrors);
      assert(saved.id === 'test' && saved.value === 'ok', 'Plain record changed');
    });
  }
  for (const algorithm of ['AES-GCM', 'X25519', 'Ed25519', 'ECDSA']) {
    const label = algorithm === 'ECDSA' ? 'P-256 ECDSA' : algorithm;
    for (const mode of ['memory', 'clone', 'inline', 'explicit']) {
      await check(`${algorithm}-${mode}`, `${label}: ${mode === 'memory' ? 'generate and use' : mode === 'clone' ? 'structured clone and use' : `${mode} storage, reopen and use`}`, async phase => {
        phase('generate');
        const pair = await bounded(generate(algorithm));
        const key = pair.privateKey || pair;
        let saved = key;
        if (mode === 'clone') {
          phase('clone');
          saved = structuredClone({ id: 'test', key }).key;
        } else if (mode === 'inline') {
          saved = (await roundTrip({ id: 'test', key }, true, phase, report.cleanupErrors)).key;
        } else if (mode === 'explicit') {
          saved = await roundTrip(key, false, phase, report.cleanupErrors);
        }
        phase('validate-key');
        validateKey(saved, algorithm === 'AES-GCM' ? 'secret' : 'private', algorithm);
        phase('use-key');
        await bounded(exercise(algorithm, saved, pair));
      });
    }
  }
  await check('encrypted-x25519', 'Experiment: AES-protected X25519 bytes, reopen, decrypt and use', async phase => {
    phase('generate');
    const aes = await bounded(generate('AES-GCM'));
    // Only this disposable test key is extractable, to evaluate a possible design.
    const pair = await bounded(crypto.subtle.generateKey('X25519', true, ['deriveBits']));
    phase('export-test-key');
    const bytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    let ciphertext;
    try { ciphertext = await bounded(crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, bytes)); }
    finally { bytes.fill(0); }
    const saved = await roundTrip({ id: 'test', aes, iv, ciphertext }, true, phase, report.cleanupErrors);
    phase('validate-aes');
    validateKey(saved.aes, 'secret', 'AES-GCM');
    phase('decrypt');
    const clear = new Uint8Array(await bounded(crypto.subtle.decrypt({ name: 'AES-GCM', iv: saved.iv }, saved.aes, saved.ciphertext)));
    let restored;
    try {
      phase('import');
      restored = await bounded(crypto.subtle.importKey('pkcs8', clear, 'X25519', false, ['deriveBits']));
    } finally { clear.fill(0); }
    phase('use-restored-key');
    validateKey(restored, 'private', 'X25519');
    await bounded(exercise('X25519', restored, pair));
  });
  return report;
}
