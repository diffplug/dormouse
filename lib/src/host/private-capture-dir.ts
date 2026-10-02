/**
 * Per-process screenshot directory (docs/specs/dor-browser.md -> "Browser Host").
 * mkdtemp makes an unguessable 0700 directory on Unix. Windows inherits the
 * temp parent's ACL; this module applies no Windows permission boundary.
 */
import * as os from 'os';
import * as path from 'path';
import { promises as fs, rmSync } from 'fs';

export interface PrivateCaptureDir {
  /** The directory, created on first use. */
  get(): Promise<string>;
  /** Drop the directory and every frame in it. Safe to repeat; a later `get()` creates a fresh one. */
  remove(): Promise<void>;
}

export function privateCaptureDir(prefix: string): PrivateCaptureDir {
  let once: Promise<string> | null = null;

  function get(): Promise<string> {
    // Unix modes do not restrict an inherited Windows ACL.
    once ??= fs.mkdtemp(path.join(os.tmpdir(), prefix)).then(async (dir) => {
      if (process.platform !== 'win32') await fs.chmod(dir, 0o700).catch(() => {});
      // Backstop for an exit that never reaches `remove` — a crash, or a host
      // that skips its shutdown hook. An `exit` handler cannot await, hence the
      // sync removal.
      process.once('exit', () => {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      });
      return dir;
    }).catch((err: unknown) => {
      // Never memoize the failure. `??=` would otherwise cache the rejected
      // promise, so one transient EACCES/ENOSPC on tmpdir would disable
      // screenshots for the rest of this process's life with no retry.
      once = null;
      throw err;
    });
    return once;
  }

  async function remove(): Promise<void> {
    const pending = once;
    once = null;
    // Awaited, so a directory still being created is dropped rather than leaked.
    const dir = await pending?.catch(() => undefined);
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  return { get, remove };
}
