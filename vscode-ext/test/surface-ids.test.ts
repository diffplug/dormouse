import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSurfaceIdAllocator } from '../src/surface-ids';

let dir: string;
const file = () => path.join(dir, 'surface-ids.json');
const ceiling = async () => (JSON.parse(await readFile(file(), 'utf8')) as { surface: number }).surface;
const logger = { error: vi.fn() };
const numbers = (ids: string[]) => ids.map((id) => Number(id.slice('surface-'.length)));

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'dormouse-surface-ids-'));
  logger.error.mockClear();
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('createSurfaceIdAllocator', () => {
  it('persists a ceiling above a block before handing it out, and a later run starts there', async () => {
    const first = createSurfaceIdAllocator(dir, logger);
    expect(await first.reserve(3, 0)).toEqual(['surface-1', 'surface-2', 'surface-3']);
    const persisted = await ceiling();
    expect(persisted).toBeGreaterThan(3);
    expect(await first.reserve(1, 0)).toEqual(['surface-4']);
    const later = createSurfaceIdAllocator(dir, logger);
    expect(numbers(await later.reserve(1, 0))).toEqual([persisted]);
  });

  it('never regresses below a higher ceiling another window wrote', async () => {
    // Two empty windows sharing globalStorageUri.
    const mine = createSurfaceIdAllocator(dir, logger);
    const theirs = createSurfaceIdAllocator(dir, logger);
    const minted = numbers(await mine.reserve(64, 0));
    const theirBlock = numbers(await theirs.reserve(64, 0));
    const theirCeiling = await ceiling();
    // Drain mine well past the ceiling it wrote, so it raises again.
    for (let i = 0; i < 20; i++) minted.push(...numbers(await mine.reserve(64, 0)));
    expect(minted.filter((n) => theirBlock.includes(n))).toEqual([]);
    expect(await ceiling()).toBeGreaterThan(theirCeiling);
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
