import { readFile } from 'node:fs/promises';
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
    // Two empty windows sharing globalStorageUri.
    const mine = createSurfaceIdAllocator(dir, logger);
    const theirs = createSurfaceIdAllocator(dir, logger);
    const minted = numbers(await mine.reserve(8, 0));
    const theirBlock = numbers(await theirs.reserve(8, 0));
    const theirMark = await persisted();
    minted.push(...numbers(await mine.reserve(8, 0)));
    expect(minted.filter((n) => theirBlock.includes(n))).toEqual([]);
    expect(await persisted()).toBeGreaterThan(theirMark);
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
