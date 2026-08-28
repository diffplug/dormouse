/**
 * The running server's own answer to "which release is this?".
 *
 * `/api/hello` is unauthenticated, CORS-`*` and reachable through
 * `tailscale serve`, so it cannot carry release identity. But every installer
 * needs that identity: a 200 on the loopback port proves only that *something*
 * got there first, and reporting a stale orphan — or, on WSL with
 * `networkingMode=mirrored`, a Windows process sharing the same loopback — as
 * the release just installed turns a failed update into a reported success.
 *
 * Reconstructing it from outside costs a different forensic implementation per
 * platform (`lsof -d txt`, `/proc/<pid>/exe`, `Get-CimInstance Win32_Process`),
 * each with its own trap about which path form the OS reports. Writing it down
 * at bind time replaces all of them with reading one small JSON file.
 *
 * Deliberately *not* in `$DORMOUSE_STATE_DIR`: this is runtime truth about one
 * process, not durable state. It must not be backed up, restored, or survive
 * into a different machine's install, all of which the state directory's
 * contract invites. The installer picks the path and passes it as
 * `DORMOUSE_RUNTIME_FILE`; unset — a dev run, a container, a test — writes
 * nothing at all.
 *
 * Source of truth for the installers' `listening_release` /
 * `Get-ListeningRelease`.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** What a running server records about itself, once it has actually bound. */
export interface RuntimeInfo {
  /** The listening process. A reader must confirm it is still alive. */
  pid: number;
  /**
   * The release directory's name, or `null` when the server was not started by
   * an installer. A reader comparing against `null` must treat it as "unknown",
   * never as a match.
   */
  releaseId: string | null;
  /** The port actually bound, which is what makes this file about *this* socket. */
  port: number;
  origin: string;
  /** ISO-8601, for an operator reading the file by hand. */
  startedAt: string;
}

/**
 * Write `info` to `path` atomically, mode `0600`.
 *
 * Called only after a successful bind: writing before would claim a port this
 * process may fail to take, which is precisely the confusion the file exists to
 * remove. Failure is never fatal — a server that cannot write its identity is
 * still a working server, and the installers degrade to "identity unknown"
 * rather than to a wrong answer.
 */
export async function writeRuntimeFile(path: string, info: RuntimeInfo): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(info, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
}

/**
 * Best-effort removal on a clean exit. A crash leaves the file behind on
 * purpose: a reader checks whether the recorded pid is alive, so a stale file
 * reads as "nothing is serving" rather than as a lie, and the next successful
 * bind overwrites it regardless.
 */
export async function removeRuntimeFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    /* already gone, or never written */
  }
}
