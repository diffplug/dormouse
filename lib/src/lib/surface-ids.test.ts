import { afterEach, describe, expect, it, vi } from 'vitest';
import { installSurfaceIdPool, maxSurfaceNumber, mintSurfaceId, resetSurfaceIdPool, surfaceIdMinter } from './surface-ids';
import type { PersistedSession } from './session-types';
import { registry, type TerminalEntry } from './terminal-store';
import { registerWallHandle, stubWallHandle } from '../components/wall/wall-handles';

/** A host counter from `start`, honoring the floor and clamping a block to 64
 *  as Rust does. */
function counting(start: number) {
  let next = start;
  return vi.fn(async (count: number, floor: number) => {
    const n = Math.min(count, 64);
    next = Math.max(next, floor + 1);
    const first = next;
    next += n;
    return Array.from({ length: n }, (_, i) => `surface-${first + i}`);
  });
}

afterEach(() => { resetSurfaceIdPool(); });

describe('mintSurfaceId', () => {
  it('counts from surface-1 in the page when no host mints', () => {
    expect([mintSurfaceId(), mintSurfaceId(), mintSurfaceId()]).toEqual(['surface-1', 'surface-2', 'surface-3']);
  });

  it('mints from a small host pool once one is installed, topping it up in the background', async () => {
    const reserve = counting(500);
    await installSurfaceIdPool(reserve, 0);
    expect(reserve).toHaveBeenCalledWith(8, 0);
    expect(mintSurfaceId()).toBe('surface-500');
    // Draining past the low-water mark refills before the pool runs dry, back
    // up to the pool's size and no further: what it holds at exit is burned.
    for (let i = 0; i < 2; i++) mintSurfaceId();
    await Promise.resolve();
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(reserve).toHaveBeenLastCalledWith(3, 0);
    for (let i = 0; i < 5; i++) mintSurfaceId();
    expect(mintSurfaceId()).toBe('surface-508');
  });

  it('names the restored floor in every reservation', async () => {
    const reserve = counting(1);
    await installSurfaceIdPool(reserve, 41);
    expect(reserve).toHaveBeenCalledWith(8, 41);
    expect(mintSurfaceId()).toBe('surface-42');
  });

  it('mints an opaque id when the host cannot reserve, and recovers', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await installSurfaceIdPool(async () => { throw new Error('host down'); }, 0);
    expect(mintSurfaceId()).toMatch(/^surface-[0-9a-f-]{36}$/);
    await installSurfaceIdPool(counting(7), 0);
    expect(mintSurfaceId()).toBe('surface-7');
    expect(error).toHaveBeenCalled();
  });

  it('skips an id a Session or Wall already holds, and says so', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    registry.set('surface-1', {} as TerminalEntry);
    const unregister = registerWallHandle(stubWallHandle('ws-a', { ownsSurface: (id) => id === 'surface-2' }));
    try {
      expect(mintSurfaceId()).toBe('surface-3');
      expect(error).toHaveBeenCalledWith('[surface-ids] skipping surface-1, which is already in use');
      expect(error).toHaveBeenCalledWith('[surface-ids] skipping surface-2, which is already in use');
    } finally {
      registry.delete('surface-1');
      unregister();
    }
  });
});

describe('surfaceIdMinter', () => {
  it('has a burst larger than the pool in hand, past the host\'s block clamp', async () => {
    const reserve = counting(1);
    await installSurfaceIdPool(reserve, 0);
    const mint = await surfaceIdMinter(100);
    const burst = Array.from({ length: 100 }, () => mint());
    // Reserved past the pool's 1..8, which the burst leaves alone.
    expect(burst).toEqual(Array.from({ length: 100 }, (_, i) => `surface-${i + 9}`));
    // Past the burst, the minter falls back to the pool.
    expect(mint()).toBe('surface-1');
  });

  it('leaves the pool whole for a create that lands while a burst reserves', async () => {
    const counter = counting(1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await installSurfaceIdPool(async (count, floor) => {
      if (count === 10) await gate;
      return counter(count, floor);
    }, 0);
    const reopening = surfaceIdMinter(10);
    // A `dor split` while a 10-Surface Workspace reopens.
    expect(mintSurfaceId()).toBe('surface-1');
    release();
    const mint = await reopening;
    expect(Array.from({ length: 10 }, () => mint())).toEqual(Array.from({ length: 10 }, (_, i) => `surface-${i + 9}`));
  });

  it('counts in the page when no host mints', async () => {
    const mint = await surfaceIdMinter(2);
    expect([mint(), mint(), mintSurfaceId()]).toEqual(['surface-1', 'surface-2', 'surface-3']);
  });
});

describe('maxSurfaceNumber', () => {
  it('reads panes and doors, ignoring ids with no number', () => {
    const session = (panes: string[], doors: string[] = []) => ({
      version: 4,
      panes: panes.map((id) => ({ id })),
      doors: doors.map((id) => ({ id })),
    }) as unknown as PersistedSession;
    expect(maxSurfaceNumber([])).toBe(0);
    expect(maxSurfaceNumber([session(['surface-3', 'pane-a']), session(['surface-x'], ['surface-12'])])).toBe(12);
  });
});
