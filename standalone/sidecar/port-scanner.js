/** Requests arriving in one microtask share one process/socket scan, so a fan-out
 * of single-terminal requests costs one scan. Scans never queue behind each
 * other: each request waits only for its own batch, which is what keeps the
 * host's per-request deadline true (docs/specs/transport.md -> "Port scan
 * deadlines"). `scan(pids, count)` must budget for `count` terminals, the
 * smallest request in the batch, not the batch's total.
 */
function createPortScanner(scan) {
  let batch = null;
  return (pids) => {
    if (pids.length === 0) return Promise.resolve(new Map());
    if (!batch) {
      const current = batch = { pids: new Set(), count: Infinity };
      current.promise = Promise.resolve()
        .then(() => { batch = null; return scan([...current.pids], current.count); })
        .catch(() => new Map());
    }
    for (const pid of pids) batch.pids.add(pid);
    batch.count = Math.min(batch.count, pids.length);
    return batch.promise;
  };
}

module.exports = { createPortScanner };
