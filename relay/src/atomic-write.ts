/**
 * Temp-then-rename replacement for the Relay's state and runtime files, so a
 * crash mid-write leaves the previous file whole. The rename handling matches
 * `writeJsonAtomic` in `lib/src/host/atomic-json-file.ts`, which the Relay
 * cannot import.
 */

import { randomUUID } from 'node:crypto';
import { rename, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Replace `path` with what `write` puts in the temp path it is handed. The
 * caller does the write, so each writer keeps its own file mode in its own
 * code. The temp name is unique per write, so two writers never rename each
 * other's half-written file. `renameFile` exists for tests.
 */
export async function replaceAtomically(
  path: string,
  write: (tmp: string) => Promise<void>,
  renameFile: typeof rename = rename,
): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    await write(tmp);
    // A Windows virus scanner, a reader holding the file open, or a pending
    // deletion can hold the destination for a moment. Retry only that
    // platform's sharing failures, with ten 10ms waits; propagate a persistent
    // or unrelated failure with the old file intact.
    for (let attempt = 1; ; attempt++) {
      try {
        await renameFile(tmp, path);
        break;
      } catch (error) {
        const { code } = error as NodeJS.ErrnoException;
        const retryable = process.platform === 'win32' && (code === 'EPERM' || code === 'EBUSY');
        if (attempt >= 11 || !retryable) throw error;
        await delay(10);
      }
    }
    renamed = true;
  } finally {
    // A failed write or rename must not leave temp files behind; those of
    // `burrows.json` hold every Burrow's bearer token.
    if (!renamed) await rm(tmp, { force: true }).catch(() => {});
  }
}
