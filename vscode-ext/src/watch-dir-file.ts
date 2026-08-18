/**
 * Watch one file in a directory, or do without.
 *
 * Two things in this extension want the same watch over `globalStorageUri` —
 * the Host lease and the peer-link rendezvous — and both want it for the same
 * reason: their own timer already converges, and the watcher only makes the
 * convergence prompt. That is what makes "no watcher" a complete answer here
 * rather than a failure to report.
 *
 * `fs.watch` can fail twice over. Synchronously, when the platform or
 * filesystem cannot watch at all; and asynchronously, with an `'error'` event
 * once it is running (an inotify handle the kernel invalidated, the directory
 * removed or remounted, watch resources exhausted). The second is the
 * dangerous one: an `EventEmitter` rethrows an unheard `'error'`, so a watcher
 * nobody listens to takes the whole extension host down — every extension in
 * it, not just this one. Both failures land in the same place here.
 */

import { watch, type FSWatcher } from 'node:fs';

/**
 * Call `onChange` when `file` changes in `dir`, or return `null` if this
 * platform will not watch it. A watcher that fails later closes itself and
 * reports through `onUnavailable`, which is where the caller drops its handle;
 * it never fires more than once.
 */
export function watchDirFile(
  dir: string,
  file: string,
  onChange: () => void,
  onUnavailable: (error: Error) => void,
): FSWatcher | null {
  try {
    const watcher = watch(dir, (_event, filename) => {
      // A rename reports no filename on some platforms; take it rather than
      // miss the change.
      if (filename && filename !== file) return;
      onChange();
    });
    watcher.once('error', (error: Error) => {
      watcher.close();
      onUnavailable(error);
    });
    return watcher;
  } catch {
    return null;
  }
}
