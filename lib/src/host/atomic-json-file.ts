/**
 * The atomic JSON writer for host state: temp-then-rename so a crash cannot
 * publish a half-written file. Unix modes are set here; Windows writers inherit
 * the caller's storage DACL. Shared by
 * the Burrow state store and the Tool trust store, whose files hold a bearer
 * credential and a security decision respectively.
 */

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/** Write `value` as JSON to `path`, creating `dir` (which contains it) first.
 *  `durable` flushes the file and then its directory before resolving, for a
 *  caller that acts on the write as soon as it lands (a counter's high-water
 *  mark); without it a crash may lose a write that already resolved. */
export async function writeJsonAtomic(dir: string, path: string, value: unknown, { durable = false }: { durable?: boolean } = {}): Promise<void> {
  // 0700 dir + 0600 file: these files decide what is authorized, and the app
  // data directory is not otherwise private on a shared machine.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // `mkdir` applies its mode only when it creates the final component. Tauri
  // creates app_data_dir before spawning us, commonly under a 0755 umask, so
  // tighten an existing directory too. Best-effort, like `peer-link.ts`'s:
  // failing the whole save over the directory would lose the write instead.
  //
  // Skipped on Windows because there is nothing here to skip *to* — a Unix
  // mode is a silent no-op on that platform, and so is the 0600 on the file
  // below, so neither call protects anything. What protects it there is the
  // owner-only DACL that `burrow_state_dir` in
  // `standalone/src-tauri/src/lib.rs` applies to this directory before
  // spawning us; the files written below inherit it. This writer relies on
  // its caller supplying that private parent, rather than invoking an ACL helper.
  if (process.platform !== 'win32') await chmod(dir, 0o700).catch(() => {});
  // Temp-then-rename in the same directory, so a crash mid-write leaves the
  // previous contents intact rather than a truncated file that reads as empty.
  // Unique per write rather than per process, so a second Dormouse sharing the
  // state directory never renames a file the first one is still writing.
  const tmp = `${path}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    if (durable) {
      const handle = await open(tmp, 'w', 0o600);
      try {
        await handle.writeFile(JSON.stringify(value));
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else {
      await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
    }
    // Concurrent replacements can briefly leave a Windows destination pending
    // deletion. Retry only that platform's sharing failures, with ten 10ms waits;
    // keep the old file intact and propagate persistent or unrelated failures.
    for (let attempt = 0; ; attempt++) {
      try { await rename(tmp, path); break; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform !== 'win32' || attempt === 10 || (code !== 'EPERM' && code !== 'EBUSY')) throw error;
        await delay(10);
      }
    }
    renamed = true;
  } finally {
    // A failed rename must not accumulate temp files holding the same secret.
    if (!renamed) await rm(tmp, { force: true }).catch(() => {});
  }
  if (durable) await syncDirectory(dir);
}

/** Flush the rename itself. Best-effort: Windows cannot open a directory to
 *  flush it (NTFS journals the rename), and some filesystems refuse a
 *  directory fsync; the file's own contents are already on disk. */
async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(dir, 'r').catch(() => null);
  if (!handle) return;
  try {
    await handle.sync().catch(() => {});
  } finally {
    await handle.close();
  }
}
