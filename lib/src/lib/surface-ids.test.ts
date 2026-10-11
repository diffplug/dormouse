import { afterEach, describe, expect, it, vi } from 'vitest';
import { installSurfaceIdPool, maxSurfaceNumber, mintSurfaceId, resetSurfaceIdPool, seedSurfaceIds, surfaceIdMinter } from './surface-ids';
import type { PersistedSession } from './session-types';
import { registry, type TerminalEntry } from './terminal-store';

/** A host counter from `start`, honoring the floor and clamping a block to 64
 *  as Rust does. */
function counting(start: number) {
  let next = start;
  return vi.fn(async (count: number, floor: number) => {
    const n = Math.min(count, 64);
    next = Math.max(next, floor + 1);
    const first = next;
    next += n;
    return Array.from({ length: n }, (_, i) => `surface:${first + i}`);
  });
}

afterEach(() => { resetSurfaceIdPool(); });

describe('mintSurfaceId', () => {
  it('counts from surface:1 in the page when no host mints', () => {
    expect([mintSurfaceId(), mintSurfaceId(), mintSurfaceId()]).toEqual(['surface:1', 'surface:2', 'surface:3']);
  });

  it('mints from a small host pool once one is installed, topping it up in the background', async () => {
    const reserve = counting(500);
    await installSurfaceIdPool(reserve, 0);
    expect(reserve).toHaveBeenCalledWith(8, 0);
    expect([mintSurfaceId(), mintSurfaceId()]).toEqual(['surface:500', 'surface:501']);
    expect(reserve).toHaveBeenCalledTimes(1);
    // Draining past the low-water mark refills well before the pool runs dry,
    // back up to the pool's size and no further: what it holds at exit is burned.
    mintSurfaceId();
    await Promise.resolve();
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(reserve).toHaveBeenLastCalledWith(3, 0);
  });

  it('keeps a quick run of creates ahead of the refill round trip', async () => {
    await installSurfaceIdPool(counting(1), 0);
    for (let i = 0; i < 3; i++) mintSurfaceId();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A pool's worth of creates, faster than the next refill lands.
    expect(Array.from({ length: 8 }, () => mintSurfaceId())).toEqual(Array.from({ length: 8 }, (_, i) => `surface:${i + 4}`));
  });

  it('names the restored floor in every reservation', async () => {
    const reserve = counting(1);
    await installSurfaceIdPool(reserve, 41);
    expect(reserve).toHaveBeenCalledWith(8, 41);
    expect(mintSurfaceId()).toBe('surface:42');
  });

  it('mints an opaque id when the host cannot reserve, and recovers', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await installSurfaceIdPool(async () => { throw new Error('host down'); }, 0);
    expect(mintSurfaceId()).toMatch(/^surface:[0-9a-f-]{36}$/);
    await installSurfaceIdPool(counting(7), 0);
    expect(mintSurfaceId()).toBe('surface:7');
    expect(error).toHaveBeenCalled();
  });

  it('mints an opaque id when the host hands out none, alone or in a burst', async () => {
    // The VS Code extension host does, rather than risk a number another window holds.
    const reserve = vi.fn(async () => [] as string[]);
    await installSurfaceIdPool(reserve, 0);
    expect(mintSurfaceId()).toMatch(/^surface:[0-9a-f-]{36}$/);
    const next = await surfaceIdMinter(2);
    expect([next(), next()]).toEqual([expect.stringMatching(/^surface:[0-9a-f-]{36}$/), expect.stringMatching(/^surface:[0-9a-f-]{36}$/)]);
  });

  it('skips an id a Session already holds, and says so', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    registry.set('surface:1', {} as TerminalEntry);
    try {
      expect(mintSurfaceId()).toBe('surface:2');
      expect(error).toHaveBeenCalledWith('[surface-ids] skipping surface:1, which is already in use');
    } finally {
      registry.delete('surface:1');
    }
  });

  it('counts in the page above the Surfaces a restore seeded, never back down', () => {
    seedSurfaceIds(12);
    seedSurfaceIds(3);
    expect(mintSurfaceId()).toBe('surface:13');
  });
});

describe('surfaceIdMinter', () => {
  it('serves a burst the pool holds from the pool alone', async () => {
    const reserve = counting(1);
    await installSurfaceIdPool(reserve, 0);
    reserve.mockClear();
    const mint = await surfaceIdMinter(2);
    expect([mint(), mint()]).toEqual(['surface:1', 'surface:2']);
    expect(reserve).not.toHaveBeenCalled();
    expect(mintSurfaceId()).toBe('surface:3');
  });

  it('has a burst larger than the pool in hand, reserving only the rest, past the host\'s block clamp', async () => {
    const reserve = counting(1);
    await installSurfaceIdPool(reserve, 0);
    const mint = await surfaceIdMinter(100);
    expect(reserve.mock.calls.slice(1, 3)).toEqual([[92, 0], [28, 0]]);
    const burst = Array.from({ length: 100 }, () => mint());
    expect(burst).toEqual(Array.from({ length: 100 }, (_, i) => `surface:${i + 1}`));
    // Past the burst, the minter mints from the pool, refilled meanwhile.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mint()).toBe('surface:101');
  });

  it('leaves the pool whole for a create that lands while a burst reserves', async () => {
    const counter = counting(1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let installed = false;
    await installSurfaceIdPool(async (count, floor) => {
      if (installed) await gate;
      return counter(count, floor);
    }, 0);
    installed = true;
    const reopening = surfaceIdMinter(10);
    // A `dor split` while a 10-Surface Workspace reopens.
    expect(mintSurfaceId()).toBe('surface:1');
    release();
    const mint = await reopening;
    expect(Array.from({ length: 10 }, () => mint())).toEqual(Array.from({ length: 10 }, (_, i) => `surface:${i + 2}`));
  });

  it('counts in the page when no host mints', async () => {
    const mint = await surfaceIdMinter(2);
    expect([mint(), mint(), mintSurfaceId()]).toEqual(['surface:1', 'surface:2', 'surface:3']);
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
    expect(maxSurfaceNumber([session(['surface:3', 'pane-a']), session(['surface:x'], ['surface:12'])])).toBe(12);
  });
});
