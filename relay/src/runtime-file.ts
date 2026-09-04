/**
 * Atomic runtime release identity written after bind and kept outside durable
 * state; see `docs/specs/relay.md` → "Configuration" and `SELF_HOST.md`.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** What a running Relay records about itself, once it has actually bound. */
export interface RuntimeInfo {
  /** The listening process. A reader must confirm it is still alive. */
  pid: number;
  /**
   * The release directory's name, or `null` when the Relay was not started by
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
 * remove. Failure is never fatal — a Relay that cannot write its identity is
 * still a working Relay, and the installers degrade to "identity unknown"
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
