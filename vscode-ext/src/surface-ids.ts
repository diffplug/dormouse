/**
 * The install's Surface id counter (docs/specs/vscode.md → "Surface id
 * minting"): every webview of every window reserves `surface:<n>` blocks from
 * it, so an id names one Surface across the install.
 *
 * Its next number lives in one `surface-ids.json` under `globalStorageUri`,
 * which no handed-out number has reached, mirroring standalone's `ids.rs`.
 * Every window's extension host is its own process, so each reservation takes
 * a cross-process lock, re-reads the file under it — another window may have
 * moved it — and writes the end of its block there, flushed to disk, before
 * handing anything out. A later run starting there reuses nothing and skips
 * nothing: no slack, since a `dor` handle is the number and webviews reserve a few ids
 * at a time. A reservation that cannot do all that in time hands out nothing.
 * Reservations queued behind one in flight share the next lock, read, and write.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { surfaceIdFor } from 'dor/protocol';
import { renameRetrying, writeJsonAtomic } from '../../lib/src/host/atomic-json-file';
import { ID_RESERVE_MAX_BLOCK, SURFACE_ID_RESERVE_WAIT_MS } from '../../lib/src/lib/platform/types';
import { log } from './log';

const FILE = 'surface-ids.json';
const VERSION = 1;
/** The holder's record inside the lock directory. */
const OWNER = 'owner.json';
/** A lock whose holder is alive is broken only once this window has watched it
 *  stand this long, by its own monotonic clock — so a sleep never ages one.
 *  A live holder keeps it for one read and one flushed write: a few ms, rarely
 *  a second on a slow disk or under a virus scanner. */
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 10;

export interface SurfaceIdAllocator {
  /** `count` ids (clamped to 1..`ID_RESERVE_MAX_BLOCK`), each numbered above `floor` and above every
   *  id any window or earlier run handed out. Never rejects; resolves empty when
   *  it cannot persist a block under the cross-window lock within
   *  `SURFACE_ID_RESERVE_WAIT_MS` of the call, so the webview mints
   *  `surface:<uuid>`, which no window can duplicate. */
  reserve(count: number, floor: number): Promise<string[]>;
}

interface AllocatorLog { error(message: string): void }

/** Overrides for tests. */
export interface AllocatorTiming { waitMs?: number; staleMs?: number }

interface Owner { pid: number; token: string }

/** The holder a lock directory names: `undefined` when there is no lock,
 *  `null` when it names none (an unreadable record). */
async function readOwner(dir: string): Promise<Owner | null | undefined> {
  try {
    const { pid, token } = JSON.parse(await readFile(path.join(dir, OWNER), 'utf8')) as Partial<Owner>;
    return Number.isSafeInteger(pid) && (pid as number) > 0 && typeof token === 'string' ? { pid: pid as number, token } : null;
  } catch {
    return stat(dir).then(() => null, () => undefined);
  }
}

/** False only when `pid` is provably gone. A reused pid reads as alive, which
 *  only delays breaking the dead holder's lock until it is stale. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Remove `lock` if it is still the one held by `token` (`null`: one naming no
 * holder). Moved aside first and checked there, so a lock someone took since
 * it was judged goes back rather than being deleted. Accepted limit: another
 * window taking the free path in the instant between the move and the move
 * back leaves two holders; it needs a holder judged gone and two windows
 * removing its lock at once.
 */
async function removeLock(lock: string, token: string | null, logger: AllocatorLog): Promise<void> {
  const aside = `${lock}.${randomUUID()}`;
  try {
    // A Windows virus scanner can hold the directory for a moment; a lock
    // left in place stalls every window until it is stale.
    await renameRetrying(lock, aside, { attempts: 5, retryable: ({ code }) => code !== 'ENOENT' });
  } catch {
    return;
  }
  if (((await readOwner(aside))?.token ?? null) !== token) {
    try {
      await rename(aside, lock);
      return;
    } catch (error) {
      logger.error(`[surface-ids] could not put back ${lock}: ${String(error)}`);
    }
  }
  await rm(aside, { recursive: true, force: true }).catch(() => {});
}

/**
 * Run `body` holding `lock`, a directory renamed into place with its holder's
 * record already inside — the atomic rename is the lock across extension
 * hosts, and a lock never lacks its record. Breaks a lock only when its holder
 * is provably dead or this window has watched it stand `staleMs`; releases
 * only its own. Resolves null, without running `body`, when the lock is not
 * had by `deadline`: `body` never runs unlocked.
 */
async function withLock<T>(
  lock: string,
  deadline: number,
  judge: (owner: Owner | null) => boolean,
  logger: AllocatorLog,
  body: () => Promise<T>,
): Promise<T | null> {
  const token = randomUUID();
  const mine = `${lock}.${token}`;
  let held = false;
  try {
    await mkdir(mine);
    await writeFile(path.join(mine, OWNER), JSON.stringify({ pid: process.pid, token } satisfies Owner));
    // Checked before each try, so a reservation dequeued past its deadline
    // writes nothing and the ones queued behind it are not held up.
    while (performance.now() < deadline) {
      try {
        await rename(mine, lock);
        held = true;
        break;
      } catch {
        // Held, or a passing error; either way, look at what is there.
      }
      const owner = await readOwner(lock);
      if (owner !== undefined && judge(owner)) await removeLock(lock, owner?.token ?? null, logger);
      else await delay(LOCK_RETRY_MS);
    }
  } catch (error) {
    logger.error(`[surface-ids] lock ${lock}: ${String(error)}`);
  } finally {
    if (!held) await rm(mine, { recursive: true, force: true }).catch(() => {});
  }
  if (!held) {
    logger.error(`[surface-ids] no ${lock} in time; handing out no ids`);
    return null;
  }
  try {
    return await body();
  } finally {
    await removeLock(lock, token, logger);
  }
}

/** One webview's reservation, waiting for its turn at the lock. */
interface Request {
  n: number;
  above: number;
  deadline: number;
  resolve(ids: string[]): void;
}

/** A counter persisted under `dir`. */
export function createSurfaceIdAllocator(dir: string, logger: AllocatorLog, timing: AllocatorTiming = {}): SurfaceIdAllocator {
  const file = path.join(dir, FILE);
  const lock = `${file}.lock`;
  const waitMs = timing.waitMs ?? SURFACE_ID_RESERVE_WAIT_MS;
  const staleMs = timing.staleMs ?? LOCK_STALE_MS;
  /** The lowest number not yet handed out. */
  let next = 1;
  /** Arrival order; the lock orders this process against the others. */
  const queue: Request[] = [];
  let draining = false;

  /** Created once; a failure shows up as the lock's or the write's. */
  let storageReady: Promise<unknown> | null = null;

  /** The live-held lock this window last saw, and since when. */
  let watched: { token: string | null; since: number } | null = null;

  function breakable(owner: Owner | null): boolean {
    if (owner && !isAlive(owner.pid)) return true;
    const token = owner?.token ?? null;
    const now = performance.now();
    if (watched?.token !== token) {
      watched = { token, since: now };
      return false;
    }
    return now - watched.since >= staleMs;
  }

  /**
   * The persisted next number, or null when this window must hand out none:
   * a read failing for any reason but the file's absence (a Windows virus
   * scanner's EBUSY, say) or a file another version wrote. Either may hold a
   * mark above every number this window knows of, and handing out or writing
   * over it would reuse numbers; another version's file is never overwritten.
   *
   * A file this version cannot parse at all is overwritten, from this
   * window's own counter and the webview's floor. Every write is atomic, so
   * only outside damage leaves one, and refusing it would leave the install
   * on opaque ids until someone deleted the file by hand; the cost is that
   * numbers handed out since the restored Surfaces' floor may be reused.
   * Standalone's `ids.json` takes the same policy (`Counters::load` in
   * `standalone/src-tauri/src/ids.rs`).
   */
  async function persistedNext(): Promise<number | null> {
    let contents: string;
    try {
      contents = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      logger.error(`[surface-ids] read ${file}: ${String(error)}; handing out no ids`);
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      parsed = undefined;
    }
    const { version, surface } = (parsed !== null && typeof parsed === 'object' ? parsed : {}) as { version?: unknown; surface?: unknown };
    if (typeof version === 'number' && version !== VERSION) {
      logger.error(`[surface-ids] ${file} has version ${version}, not ${VERSION}; handing out no ids, and leaving it alone`);
      return null;
    }
    if (version === VERSION && Number.isSafeInteger(surface) && (surface as number) >= 0) return surface as number;
    logger.error(`[surface-ids] ${file} is unreadable; overwriting it from this window's counter`);
    return 0;
  }

  /** Take `n` numbers above `above`, `next`, and `persisted`. */
  function take(n: number, above: number, persisted: number): number {
    // Numbers below the persisted one belong to another window or an earlier run.
    const first = Math.max(next, above + 1, persisted);
    next = first + n;
    return first;
  }

  /**
   * Under the lock: every queued reservation still within its deadline takes
   * its block, in arrival order, and one write persists the end of the last.
   * Each answer is its block, or none when the file could not be read or the
   * write failed — another window, not seeing it, could hand out the same
   * numbers.
   */
  async function reserveQueued(): Promise<Array<[Request, string[]]>> {
    const batch = queue.splice(0);
    const persisted = await persistedNext();
    if (persisted === null) return batch.map((request) => [request, []]);
    const now = performance.now();
    const firsts = batch.map((request) => now < request.deadline ? take(request.n, request.above, persisted) : null);
    if (firsts.some((first) => first !== null)) {
      try {
        await writeJsonAtomic(path.dirname(file), file, { version: VERSION, surface: next }, { durable: true });
      } catch (error) {
        logger.error(`[surface-ids] write ${file}: ${String(error)}; handing out no ids`);
        return batch.map((request) => [request, []]);
      }
    }
    return batch.map((request, i) => {
      const first = firsts[i];
      return [request, first === null ? [] : Array.from({ length: request.n }, (_, k) => surfaceIdFor(first + k))];
    });
  }

  async function drain(): Promise<void> {
    draining = true;
    try {
      while (queue.length > 0) {
        await (storageReady ??= mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => {}));
        // The head arrived first, so its deadline is the earliest.
        const head = queue[0];
        const answers = await withLock(lock, head.deadline, breakable, logger, reserveQueued);
        if (answers === null) {
          queue.shift();
          head.resolve([]);
          continue;
        }
        for (const [request, ids] of answers) request.resolve(ids);
      }
    } finally {
      draining = false;
    }
  }

  return {
    // The wait counts from arrival, so a reservation queued behind others
    // still answers within the bound the webview's timeout allows for.
    reserve: (count, floor) => new Promise((resolve) => {
      queue.push({
        n: Math.max(1, Math.min(ID_RESERVE_MAX_BLOCK, Math.trunc(count) || 1)),
        above: Number.isSafeInteger(floor) && floor > 0 ? floor : 0,
        deadline: performance.now() + waitMs,
        resolve,
      });
      if (!draining) void drain();
    }),
  };
}

/** None until activation names the install's storage. */
let allocator: SurfaceIdAllocator | null = null;

/** Activation: persist the install's counter under `dir` (`globalStorageUri`). */
export function initSurfaceIds(dir: string): void {
  allocator = createSurfaceIdAllocator(dir, log);
}

/** No ids before activation: the webview mints `surface:<uuid>`. */
export function reserveSurfaceIds(count: number, floor: number): Promise<string[]> {
  return allocator?.reserve(count, floor) ?? Promise.resolve([]);
}
