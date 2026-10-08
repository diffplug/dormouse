/**
 * The install's Surface id counter (docs/specs/vscode.md → "Surface id
 * minting"): every webview of every window reserves `surface-<n>` blocks from
 * it, so an id names one Surface across the install.
 *
 * Its next number lives in one `surface-ids.json` under `globalStorageUri`,
 * which no handed-out number has reached, mirroring standalone's `ids.rs`.
 * Every window's extension host is its own process, so each reservation takes
 * a cross-process lock, re-reads the file under it — another window may have
 * moved it — and writes the end of its block there, flushed to disk, before
 * handing anything out. A later run starting there reuses nothing and skips
 * nothing: no slack, since a ref is the number and webviews reserve a few ids
 * at a time.
 */

import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { surfaceIdFor, surfaceIdNumber } from 'dor/protocol';
import { writeJsonAtomic } from '../../lib/src/host/atomic-json-file';
import { createSerialQueue } from '../../lib/src/host/remote/serial-queue';
import { log } from './log';

const FILE = 'surface-ids.json';
const VERSION = 1;
const MAX_BLOCK = 64;
/** A lock older than this was left by an extension host that died holding it:
 *  a holder keeps it for one read and one flushed write. */
const LOCK_STALE_MS = 5_000;
const LOCK_RETRY_MS = 10;
/** Past the stale age, so a dead holder's lock is always broken first. */
const LOCK_ATTEMPTS = 1_000;

export interface SurfaceIdAllocator {
  /** `count` ids (clamped to 1..64), each numbered above `floor` and above every
   *  id any window or earlier run handed out. Never rejects. */
  reserve(count: number, floor: number): Promise<string[]>;
}

interface AllocatorLog { error(message: string): void }

/**
 * Run `body` holding `lock`, a directory whose atomic `mkdir` is the lock
 * across extension hosts. A stale one is removed by age. Two waiters can both
 * judge one stale and the second remove the first's fresh lock, which only a
 * dead holder can set up; past the attempts, `body` runs unlocked rather than
 * leaving the webview without ids.
 */
async function withLock<T>(lock: string, logger: AllocatorLog, body: () => Promise<T>): Promise<T> {
  let held = false;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS && !held; attempt++) {
    try {
      await mkdir(lock);
      held = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        logger.error(`[surface-ids] lock ${lock}: ${String(error)}`);
        break;
      }
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > LOCK_STALE_MS) await rm(lock, { recursive: true, force: true }).catch(() => {});
      else await delay(LOCK_RETRY_MS);
    }
  }
  if (!held) logger.error(`[surface-ids] reserving without ${lock}`);
  try {
    return await body();
  } finally {
    if (held) await rm(lock, { recursive: true, force: true }).catch(() => {});
  }
}

/** A counter persisted under `dir`, or kept in memory alone when there is none. */
export function createSurfaceIdAllocator(dir: string | null, logger: AllocatorLog): SurfaceIdAllocator {
  const file = dir === null ? null : path.join(dir, FILE);
  /** The lowest number not yet handed out. */
  let next = 1;
  // One at a time within this process; the lock orders it against the others.
  const serialize = createSerialQueue();

  async function persistedNext(file: string): Promise<number> {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      const { version, surface } = (parsed ?? {}) as { version?: unknown; surface?: unknown };
      if (version === VERSION && Number.isSafeInteger(surface) && (surface as number) >= 0) return surface as number;
      logger.error(`[surface-ids] ignoring ${file}: not a version ${VERSION} counter`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logger.error(`[surface-ids] read ${file}: ${String(error)}`);
    }
    return 0;
  }

  /** Take `n` numbers above `above`, `next`, and `persisted`. */
  function take(n: number, above: number, persisted: number): number {
    // Numbers below the persisted one belong to another window or an earlier run.
    const first = Math.max(next, above + 1, persisted);
    next = first + n;
    return first;
  }

  async function reserveNow(count: number, floor: number): Promise<string[]> {
    const n = Math.max(1, Math.min(MAX_BLOCK, Math.trunc(count) || 1));
    const above = Number.isSafeInteger(floor) && floor > 0 ? floor : 0;
    const first = file === null ? take(n, above, 0) : await reserveInFile(file, n, above);
    return Array.from({ length: n }, (_, i) => surfaceIdFor(first + i));
  }

  async function reserveInFile(file: string, n: number, above: number): Promise<number> {
    const storage = path.dirname(file);
    try {
      await mkdir(storage, { recursive: true, mode: 0o700 });
    } catch (error) {
      logger.error(`[surface-ids] create ${storage}: ${String(error)}; the counter stays in memory`);
      return take(n, above, 0);
    }
    return withLock(`${file}.lock`, logger, async () => {
      const first = take(n, above, await persistedNext(file));
      try {
        await writeJsonAtomic(storage, file, { version: VERSION, surface: next }, { durable: true });
      } catch (error) {
        logger.error(`[surface-ids] write ${file}: ${String(error)}; the counter stays in memory`);
      }
      return first;
    });
  }

  return {
    reserve: (count, floor) => serialize(() => reserveNow(count, floor)),
  };
}

/** In memory until activation names the install's storage. */
let allocator = createSurfaceIdAllocator(null, log);

/** Activation: persist the install's counter under `dir` (`globalStorageUri`). */
export function initSurfaceIds(dir: string | null): void {
  allocator = createSurfaceIdAllocator(dir, log);
}

/** The highest `surface-<n>` number among `ids`, else 0. */
export function highestSurfaceNumber(ids: Iterable<string>): number {
  let max = 0;
  for (const id of ids) max = Math.max(max, surfaceIdNumber(id) ?? 0);
  return max;
}

export function reserveSurfaceIds(count: number, floor: number): Promise<string[]> {
  return allocator.reserve(count, floor);
}
