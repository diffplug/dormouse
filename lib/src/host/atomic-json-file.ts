/**
 * The one way a Node-side host commits a private JSON file: owner-only, and
 * temp-then-rename so a crash can never publish a half-written one. Shared by
 * the Burrow state store and the Tool trust store, whose files hold a bearer
 * credential and a security decision respectively.
 */

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';

/** Write `value` as JSON to `path`, creating `dir` (which contains it) first. */
export async function writeJsonAtomic(dir: string, path: string, value: unknown): Promise<void> {
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
  // spawning us; the files written below inherit it. Node cannot set an ACL,
  // which is why the guarantee lives on the Rust side rather than here.
  if (process.platform !== 'win32') await chmod(dir, 0o700).catch(() => {});
  // Temp-then-rename in the same directory, so a crash mid-write leaves the
  // previous contents intact rather than a truncated file that reads as empty.
  // Unique per write rather than per process, so a second Dormouse sharing the
  // state directory never renames a file the first one is still writing.
  const tmp = `${path}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
    await rename(tmp, path);
    renamed = true;
  } finally {
    // A failed rename must not accumulate temp files holding the same secret.
    if (!renamed) await rm(tmp, { force: true }).catch(() => {});
  }
}
