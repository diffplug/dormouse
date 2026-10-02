const path = require('node:path');
const { Worker } = require('node:worker_threads');

function scanInWorker(pids) {
  return new Promise((resolve) => {
    // A fresh worker exits after its one bounded scan. No idle worker or native
    // PTY module is retained, and a failed worker keeps enumeration fail-soft.
    try {
      const worker = new Worker(path.join(__dirname, 'port-scan-worker.js'), { workerData: pids });
      worker.once('message', resolve);
      worker.once('error', () => resolve(new Map()));
      worker.once('exit', () => resolve(new Map()));
    } catch { resolve(new Map()); }
  });
}

/** One scan in flight; requests arriving together share a process/socket scan.
 * Calls arriving during a scan join the next batch, so their answer is fresh.
 * Keeping this queue outside the worker lets the PTY thread keep handling I/O.
 */
function createPortScanner(scan = scanInWorker) {
  let pending = [];
  let running = false;
  async function drain() {
    if (running || pending.length === 0) return;
    running = true;
    const batch = pending;
    pending = [];
    const pids = [...new Set(batch.flatMap((request) => request.pids))];
    let ports;
    try { ports = await scan(pids); }
    catch { ports = new Map(); }
    for (const request of batch) request.resolve(ports);
    running = false;
    void drain();
  }
  return (pids) => {
    if (pids.length === 0) return Promise.resolve(new Map());
    return new Promise((resolve) => {
      pending.push({ pids, resolve });
      queueMicrotask(drain);
    });
  };
}

module.exports = { createPortScanner };
