/** Requests arriving in one microtask share one process/socket scan, so a fan-out
 * of single-terminal requests costs one scan. Scans never queue behind each
 * other: each request waits only for its own batch, which is what keeps the
 * host's per-request deadline true (docs/specs/transport.md -> "Port scan
 * deadlines"). `scan(roots, count)` gets each `{ pid }` root once and must
 * budget for `count` terminals, the smallest request in the batch, not the
 * batch's total.
 */
function createPortScanner(scan) {
  let batch = null;
  return (roots) => {
    if (roots.length === 0) return Promise.resolve(new Map());
    if (!batch) {
      const current = batch = { roots: new Map(), count: Infinity };
      current.promise = Promise.resolve()
        .then(() => { batch = null; return scan([...current.roots.values()], current.count); })
        .catch(() => new Map());
    }
    for (const root of roots) batch.roots.set(root.pid, root);
    batch.count = Math.min(batch.count, roots.length);
    return batch.promise;
  };
}

module.exports = { createPortScanner };
