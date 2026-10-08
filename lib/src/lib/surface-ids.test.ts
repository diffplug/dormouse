import { afterEach, describe, expect, it, vi } from 'vitest';
import { installSurfaceIdPool, maxSurfaceNumber, mintSurfaceId, resetSurfaceIdPool } from './surface-ids';
import type { PersistedSession } from './session-types';
import { registry, type TerminalEntry } from './terminal-store';
import { registerWallHandle, stubWallHandle } from '../components/wall/wall-handles';

/** A host counter from `start`, honoring the floor as Rust does. */
function counting(start: number) {
  let next = start;
  return vi.fn(async (count: number, floor: number) => {
    next = Math.max(next, floor + 1);
    const first = next;
    next += count;
    return Array.from({ length: count }, (_, i) => `surface-${first + i}`);
  });
}

afterEach(() => { resetSurfaceIdPool(); });

describe('mintSurfaceId', () => {
  it('counts from surface-1 in the page when no host mints', () => {
    expect([mintSurfaceId(), mintSurfaceId(), mintSurfaceId()]).toEqual(['surface-1', 'surface-2', 'surface-3']);
  });

  it('mints from the host pool once one is installed, refilling in the background', async () => {
    const reserve = counting(500);
    await installSurfaceIdPool(reserve, 0);
    expect(reserve).toHaveBeenCalledWith(64, 0);
    expect(mintSurfaceId()).toBe('surface-500');
    // Draining past the low-water mark refills before the pool runs dry.
    for (let i = 0; i < 48; i++) mintSurfaceId();
    await Promise.resolve();
    expect(reserve).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 15; i++) mintSurfaceId();
    expect(mintSurfaceId()).toBe('surface-564');
  });

  it('names the restored floor in every reservation', async () => {
    const reserve = counting(1);
    await installSurfaceIdPool(reserve, 41);
    expect(reserve).toHaveBeenCalledWith(64, 41);
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

describe('maxSurfaceNumber', () => {
  it('reads panes and doors, ignoring ids with no number', () => {
    const session = (panes: string[], doors: string[] = []) => ({
      version: 3,
      panes: panes.map((id) => ({ id })),
      doors: doors.map((id) => ({ id })),
    }) as unknown as PersistedSession;
    expect(maxSurfaceNumber([])).toBe(0);
    expect(maxSurfaceNumber([session(['surface-3', 'pane-a']), session(['surface-x'], ['surface-12'])])).toBe(12);
  });
});
