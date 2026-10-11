import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { surfaceIdNumber } from 'dor/protocol';
import { createSurfaceIdAllocator, reserveSurfaceIds } from '../src/surface-ids';
import { removeDir, tempStorageDir } from './helpers';

/** Runs before each durable write, while the allocator holds the lock. */
const hooks = vi.hoisted(() => ({ duringWrite: null as null | (() => Promise<void>), writes: 0 }));
vi.mock('../../lib/src/host/atomic-json-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/src/host/atomic-json-file')>();
  return {
    ...actual,
    writeJsonAtomic: async (...args: Parameters<typeof actual.writeJsonAtomic>) => {
      hooks.writes++;
      await hooks.duringWrite?.();
      return actual.writeJsonAtomic(...args);
    },
  };
});

let dir: string;
const file = () => path.join(dir, 'surface-ids.json');
const persisted = async () => (JSON.parse(await readFile(file(), 'utf8')) as { surface: number }).surface;
const logger = { error: vi.fn() };
const numbers = (ids: string[]) => ids.map(surfaceIdNumber);

const lock = () => `${file()}.lock`;
/** Another window's lock, held by `pid`. */
async function holdLock(pid: number, token = 'theirs') {
  await mkdir(lock());
  await writeFile(path.join(lock(), 'owner.json'), JSON.stringify({ pid, token }));
}
const lockToken = async () => (JSON.parse(await readFile(path.join(lock(), 'owner.json'), 'utf8')) as { token: string }).token;
/** A pid no process has: one that just exited. */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid!;

beforeEach(async () => {
  dir = await tempStorageDir();
  logger.error.mockClear();
  hooks.duringWrite = null;
  hooks.writes = 0;
});
afterEach(async () => { await removeDir(dir); });

describe('createSurfaceIdAllocator', () => {
  it('persists exactly the end of each block before handing it out, and a later run resumes there', async () => {
    const first = createSurfaceIdAllocator(dir, logger);
    expect(await first.reserve(3, 0)).toEqual(['surface:1', 'surface:2', 'surface:3']);
    expect(await persisted()).toBe(4);
    expect(await first.reserve(1, 0)).toEqual(['surface:4']);
    expect(await persisted()).toBe(5);
    // No slack: the relaunch wastes no numbers.
    const later = createSurfaceIdAllocator(dir, logger);
    expect(await later.reserve(1, 0)).toEqual(['surface:5']);
  });

  it('never hands out a number another window sharing the file did, nor writes it lower', async () => {
    // Two windows sharing globalStorageUri.
    const mine = createSurfaceIdAllocator(dir, logger);
    const theirs = createSurfaceIdAllocator(dir, logger);
    const minted = numbers(await mine.reserve(8, 0));
    const theirBlock = numbers(await theirs.reserve(8, 0));
    const theirMark = await persisted();
    minted.push(...numbers(await mine.reserve(8, 0)));
    expect(minted.filter((n) => theirBlock.includes(n))).toEqual([]);
    expect(await persisted()).toBeGreaterThan(theirMark);
  });

  it('never hands two windows racing for the file the same number', async () => {
    // Two extension hosts, each with its own in-process queue, reserving at once:
    // only the lock orders their read-raise-write.
    const windows = [createSurfaceIdAllocator(dir, logger), createSurfaceIdAllocator(dir, logger)];
    const blocks = await Promise.all(Array.from({ length: 6 }, (_, i) => windows[i % 2].reserve(4, 0)));
    const all = blocks.flatMap(numbers);
    expect(new Set(all).size).toBe(all.length);
    expect(await persisted()).toBe(Math.max(...(all as number[])) + 1);
  });

  it('waits out a lock a live holder keeps, and takes it once released', async () => {
    await holdLock(process.pid);
    const waiting = createSurfaceIdAllocator(dir, logger).reserve(1, 0);
    let settled = false;
    void waiting.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    await rm(lock(), { recursive: true });
    expect(await waiting).toEqual(['surface:1']);
    await expect(readFile(path.join(lock(), 'owner.json'))).rejects.toThrow();
  });

  it('never breaks a live holder\'s lock by its age on disk, and hands out nothing rather than run unlocked', async () => {
    // A slow flushed write can hold the lock past a second.
    await holdLock(process.pid);
    const old = new Date(Date.now() - 60_000);
    await utimes(lock(), old, old);
    expect(await createSurfaceIdAllocator(dir, logger, { waitMs: 200 }).reserve(1, 0)).toEqual([]);
    expect(await lockToken()).toBe('theirs');
    await expect(readFile(file())).rejects.toThrow();
    expect(logger.error).toHaveBeenCalled();
  });

  it('breaks a lock whose holder died', async () => {
    await holdLock(deadPid());
    expect(await createSurfaceIdAllocator(dir, logger).reserve(1, 0)).toEqual(['surface:1']);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('breaks a live holder\'s lock once it has watched it stand the stale age', async () => {
    // A reused pid, or a holder hung for good.
    await holdLock(process.pid);
    expect(await createSurfaceIdAllocator(dir, logger, { waitMs: 2_000, staleMs: 100 }).reserve(1, 0)).toEqual(['surface:1']);
  });

  it('releases only a lock it still holds', async () => {
    // Another window judged this holder gone and took the lock mid-write.
    hooks.duringWrite = async () => {
      hooks.duringWrite = null;
      await rm(lock(), { recursive: true });
      await holdLock(process.pid, 'taken');
    };
    await createSurfaceIdAllocator(dir, logger).reserve(1, 0);
    expect(await lockToken()).toBe('taken');
  });

  it('counts a queued reservation\'s wait from its arrival', async () => {
    await holdLock(process.pid);
    const allocator = createSurfaceIdAllocator(dir, logger, { waitMs: 500 });
    const started = performance.now();
    expect(await Promise.all([allocator.reserve(1, 0), allocator.reserve(1, 0), allocator.reserve(1, 0)])).toEqual([[], [], []]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('hands out nothing when it cannot persist the block', async () => {
    await mkdir(file());
    expect(await createSurfaceIdAllocator(dir, logger).reserve(1, 0)).toEqual([]);
    expect(logger.error).toHaveBeenCalled();
  });

  it('honors the floor the webview restored', async () => {
    const allocator = createSurfaceIdAllocator(dir, logger);
    expect(await allocator.reserve(2, 41)).toEqual(['surface:42', 'surface:43']);
    expect(await allocator.reserve(1, 3)).toEqual(['surface:44']);
  });

  it('clamps a block to the most one reservation hands out', async () => {
    expect(await createSurfaceIdAllocator(dir, logger).reserve(500, 0)).toHaveLength(64);
  });

  it('answers the reservations queued behind one in flight with one lock, one read, and one write', async () => {
    const allocator = createSurfaceIdAllocator(dir, logger);
    const blocks = await Promise.all([allocator.reserve(2, 0), allocator.reserve(3, 0), allocator.reserve(1, 10), allocator.reserve(2, 0)]);
    expect(hooks.writes).toBe(1);
    // Each in arrival order, the floor lifting its own block and every one after it.
    expect(blocks.map(numbers)).toEqual([[1, 2], [3, 4, 5], [11], [12, 13]]);
    expect(await persisted()).toBe(14);
  });
});

describe('reserveSurfaceIds', () => {
  it('hands out nothing before activation names the install\'s storage', async () => {
    expect(await reserveSurfaceIds(1, 0)).toEqual([]);
  });
});
