/** Private, unguessable per-process storage for authenticated browser frames.
 * Owner-only permissions precede every published capture path; successful
 * setup is shared until removal, and failures permit the next capture to retry.
 * Cleanup covers explicit shutdown and process exit. See
 * docs/specs/dor-browser.md → "Browser Host".
 */
import * as os from 'os';
import * as path from 'path';
import { promises as fs, rmSync } from 'fs';
import { ensurePrivateDirectory } from './private-path';

export interface PrivateCaptureDir {
  /** The directory, created on first use. */
  get(): Promise<string>;
  /** Drop the directory and every frame in it. Safe to repeat; a later `get()` creates a fresh one. */
  remove(): Promise<void>;
}

export function privateCaptureDir(prefix: string): PrivateCaptureDir {
  let once: Promise<string> | null = null;
  let generation = 0;

  function get(): Promise<string> {
    if (once) return once;
    const ownedGeneration = generation;
    const pending = fs.mkdtemp(path.join(os.tmpdir(), prefix)).then(async (dir) => {
      try {
        await ensurePrivateDirectory(dir);
        // Removal invalidates setup already in flight; never publish a path
        // after its owner has asked to discard it.
        if (ownedGeneration !== generation) throw new Error('Capture directory removed during setup');
      } catch (error) {
        // A failed ACL/mode setup must expose no screenshot path or leaked
        // directory. The outer catch permits a later capture to retry.
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      // Backstop for an exit that never reaches `remove` — a crash, or a host
      // that skips its shutdown hook. An `exit` handler cannot await, hence the
      // sync removal.
      process.once('exit', () => {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      });
      return dir;
    }).catch((err: unknown) => {
      // Never memoize rejected setup: a transient EACCES/ENOSPC must allow
      // a later capture to retry.
      // A discarded setup may fail after another get has begun. It must not
      // evict that newer generation from the cache.
      if (once === pending) once = null;
      throw err;
    });
    once = pending;
    return pending;
  }

  async function remove(): Promise<void> {
    const pending = once;
    once = null;
    generation++;
    // Awaited, so a directory still being created is dropped rather than leaked.
    const dir = await pending?.catch(() => undefined);
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  return { get, remove };
}
