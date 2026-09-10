/**
 * Where a Node-resident host keeps the agent resume invocations it captured
 * while tearing down, and how a cold start claims them exactly once
 * (docs/specs/standalone.md -> "Agent recovery").
 *
 * The record is single-use, rebuilt-invocation-only, and never a buffer: only
 * what `detectResumeCommand` recognized is written, so no transcript reaches
 * disk. It is deliberately NOT part of the persisted session — a webview that
 * could save it back would replay a stale invocation on a later restore
 * (docs/specs/transport.md -> "Consuming it").
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { noCommands, silent, type RecoveryLog } from './recovery-capture';

const FILE_NAME = 'recovery.json';

/** How long a record stays offerable. One cold start consumes it; this only
 *  bounds a host that never comes back. */
export const RECOVERY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface PersistedRecovery {
  createdAt: number;
  /** Surface id -> canonical agent resume invocation. */
  commands: Record<string, string>;
}

export interface RecoveryStore {
  /**
   * A teardown is about to capture. The FIRST call of a process replaces
   * whatever the last run left; later calls merge, because a Window captures
   * separately and the second must not wipe the first.
   */
  beginCapture(): void;
  /** Merge one detected invocation and persist immediately. */
  record(id: string, command: string): void;
  /** Claim the commands belonging to `paneIds`, removing each as it is handed out. */
  take(paneIds: Iterable<string>): Record<string, string>;
  /** Whether a write survives this process. `false` is the no-directory store. */
  readonly persistent: boolean;
}

/**
 * The record under `dir`, or a memory-only store when no directory was given.
 *
 * Owner-only and temp-then-rename, because a kill during the write must not
 * leave a torn record for the next start to parse — the same durability shape as
 * the standalone session snapshot.
 */
export function createRecoveryStore(dir?: string, opts: { log?: RecoveryLog } = {}): RecoveryStore {
  const log = opts.log ?? silent;
  const file = dir ? path.join(dir, FILE_NAME) : null;
  if (!file) {
    log.error('[recovery] no state directory; agent recovery will not survive this process');
  }

  // What this process has captured. Also the memory-only store's whole content.
  let captured: Record<string, string> = noCommands();
  let clearedThisProcess = false;
  // What is left of the record on disk, once read. `null` until the first `take`.
  let unclaimed: Record<string, string> | null = null;

  const persist = (): void => {
    if (!file) return;
    const payload: PersistedRecovery = { createdAt: Date.now(), commands: captured };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp`;
      // Mode on create, so the bytes are never briefly world-readable; the rename
      // preserves it.
      fs.writeFileSync(tmp, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      log.error(`[recovery] write failed: ${String(err)}`);
    }
  };

  return {
    persistent: file !== null,

    beginCapture(): void {
      if (clearedThisProcess) return;
      clearedThisProcess = true;
      // Clear before anything can return early. A record is only ever consumed by
      // a cold start that actually restores, so a teardown that captures nothing
      // must not leave the last one sitting there — otherwise a run that restores
      // nothing carries the record forward and a much later restore auto-runs a
      // week-old invocation unprompted. `record` re-creates it the moment
      // anything is detected.
      captured = noCommands();
      if (!file) return;
      try {
        fs.rmSync(file, { force: true });
      } catch (err) {
        log.error(`[recovery] could not clear the previous record: ${String(err)}`);
      }
    },

    record(id: string, command: string): void {
      captured[id] = command;
      // Persist on every change rather than once at the end. The write is a few
      // hundred bytes and costs well under a millisecond, and the shutdown budget
      // can end the capture at any instant.
      persist();
    },

    take(paneIds: Iterable<string>): Record<string, string> {
      unclaimed ??= file ? readAndClearRecord(file, log) : captured;
      const claimed: Record<string, string> = noCommands();
      for (const id of paneIds) {
        const command = unclaimed[id];
        if (command === undefined) continue;
        claimed[id] = command;
        // Entries leave the map as they are claimed, so no id is ever handed out
        // twice — a second container claiming its share sees only the remainder.
        delete unclaimed[id];
      }
      log.info(`[recovery] handing ${Object.keys(claimed).length} command(s) to a cold restore`
        + ` (${Object.keys(unclaimed).length} unclaimed)`);
      return claimed;
    },
  };
}

/**
 * Read the record and remove it. Destructive on the first call of a process, so
 * the durable copy is gone before anything can act on it and a failed start
 * cannot replay it.
 */
function readAndClearRecord(file: string, log: RecoveryLog): Record<string, string> {
  if (!fs.existsSync(file)) return noCommands();

  let recovery: PersistedRecovery | null = null;
  try {
    recovery = JSON.parse(fs.readFileSync(file, 'utf8')) as PersistedRecovery;
  } catch (err) {
    log.error(`[recovery] unreadable record; discarding: ${String(err)}`);
  }
  // Destructive even on a parse failure: a record that cannot be understood must
  // not sit on disk waiting to be retried forever.
  try {
    fs.unlinkSync(file);
  } catch {
    // If it cannot be removed, do not use it — better to lose one recovery than
    // to re-run an agent on every start from a record we cannot clear.
    log.error('[recovery] could not clear record; ignoring it');
    return noCommands();
  }
  if (!recovery) return noCommands();

  const age = Date.now() - (recovery.createdAt ?? 0);
  if (age > RECOVERY_MAX_AGE_MS) {
    log.info(`[recovery] discarding record ${Math.round(age / 86_400_000)}d old`);
    return noCommands();
  }

  // Shape-guard every entry. This file is plain JSON on disk and its values end up
  // typed into a shell, so a torn or hand-edited record must fail as one dropped
  // entry rather than as something later code has to survive.
  const raw: unknown = recovery.commands;
  const commands: Record<string, string> = noCommands();
  if (raw && typeof raw === 'object') {
    for (const [id, command] of Object.entries(raw)) {
      if (typeof command !== 'string') {
        log.error(`[recovery] dropping ${id}: expected a string, got ${typeof command}`);
        continue;
      }
      commands[id] = command;
    }
  }
  log.info(`[recovery] read ${Object.keys(commands).length} command(s) from the record`);
  return commands;
}
