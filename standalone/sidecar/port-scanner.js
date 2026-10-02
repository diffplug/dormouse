/** One scan in flight; requests arriving together share a process/socket scan.
 * Calls arriving during a scan join the next batch, so their answer is fresh.
 */
function createPortScanner(scan) {
  let next = null; // the batch still accepting pids
  let tail = Promise.resolve();
  return (pids) => {
    if (pids.length === 0) return Promise.resolve(new Map());
    if (!next) {
      const batch = next = { pids: new Set() };
      tail = batch.promise = tail
        .then(() => { next = null; return scan([...batch.pids]); })
        .catch(() => new Map());
    }
    for (const pid of pids) next.pids.add(pid);
    return next.promise;
  };
}

module.exports = { createPortScanner };
