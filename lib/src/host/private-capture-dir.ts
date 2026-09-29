/**
 * The private per-process directory the browser host's captures are written
 * into (docs/specs/dor-browser.md → "Viewer Socket"; `./browser-capture.ts`).
 *
 * A frame is a picture of the user's authenticated browser, so the *directory*
 * is the control: one `mkdtemp` per host, which is `0700` and unguessable. A
 * derivable path directly in `os.tmpdir()` let any other local account read
 * every frame, or pre-create the name as a symlink and have the writer clobber
 * whatever it pointed at. `standalone/sidecar/clipboard-ops.js` does the same
 * for clipboard images; the paths are meant to match, cleanup included — a
 * frame of someone's authenticated browser is not something to leave in tmp for
 * the OS to reap whenever it gets round to it.
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
    // mkdtemp creates at 0700 already; the chmod covers an inherited-mode
    // filesystem and is a no-op on Windows, where %TEMP% is per-user.
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
