import { mkdir, readFile, rm, utimes } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { surfaceIdNumber } from 'dor/protocol';
import { createSurfaceIdAllocator } from '../src/surface-ids';
import { removeDir, tempStorageDir } from './helpers';

let dir: string;
const file = () => path.join(dir, 'surface-ids.json');
const persisted = async () => (JSON.parse(await readFile(file(), 'utf8')) as { surface: number }).surface;
const logger = { error: vi.fn() };
const numbers = (ids: string[]) => ids.map(surfaceIdNumber);

beforeEach(async () => {
  dir = await tempStorageDir();
  logger.error.mockClear();
});
afterEach(async () => { await removeDir(dir); });

describe('createSurfaceIdAllocator', () => {
  it('persists exactly the end of each block before handing it out, and a later run resumes there', async () => {
    const first = createSurfaceIdAllocator(dir, logger);
    expect(await first.reserve(3, 0)).toEqual(['surface-1', 'surface-2', 'surface-3']);
    expect(await persisted()).toBe(4);
    expect(await first.reserve(1, 0)).toEqual(['surface-4']);
    expect(await persisted()).toBe(5);
    // No slack: the relaunch wastes no numbers.
    const later = createSurfaceIdAllocator(dir, logger);
    expect(await later.reserve(1, 0)).toEqual(['surface-5']);
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

  it('waits out a held lock, and breaks one its holder left behind', async () => {
    const lock = `${file()}.lock`;
    await mkdir(lock);
    const waiting = createSurfaceIdAllocator(dir, logger).reserve(1, 0);
    let settled = false;
    void waiting.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    await rm(lock, { recursive: true });
    expect(await waiting).toEqual(['surface-1']);

    await mkdir(lock);
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    expect(await createSurfaceIdAllocator(dir, logger).reserve(1, 0)).toEqual(['surface-2']);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('honors the floor the webview restored', async () => {
    const allocator = createSurfaceIdAllocator(dir, logger);
    expect(await allocator.reserve(2, 41)).toEqual(['surface-42', 'surface-43']);
    expect(await allocator.reserve(1, 3)).toEqual(['surface-44']);
  });

  it('hands out ids from memory alone when it has no storage', async () => {
    const allocator = createSurfaceIdAllocator(null, logger);
    expect(await allocator.reserve(500, 0)).toHaveLength(64);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
