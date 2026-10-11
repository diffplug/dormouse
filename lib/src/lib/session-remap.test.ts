import { afterEach, describe, expect, it, vi } from 'vitest';
import { withFreshSurfaceIds } from './session-remap';
import type { PersistedSession } from './session-types';
import { installSurfaceIdPool, mintSurfaceId, resetSurfaceIdPool } from './surface-ids';

afterEach(() => { resetSurfaceIdPool(); });

describe('withFreshSurfaceIds', () => {
  const session: PersistedSession = {
    version: 4,
    panes: [
      { id: 'a', cwd: '/repo', title: 'shell', untouched: true },
      { id: 'b', cwd: null, title: 'docs', untouched: false, surfaceType: 'browser' },
      { id: 'door', cwd: '/repo', title: 'min', untouched: true },
    ],
    doors: [{ id: 'door', title: 'min', token: { leafId: 'door', siblingId: 'a', siblingLeafIds: ['a', 'gone'], weight: 0.5, edge: 'right', index: 1, fingerprint: null } }],
    lathLayout: {
      version: 1,
      tree: { root: { kind: 'split', dir: 'row', children: [{ node: { kind: 'leaf', id: 'a' }, weight: 0.5 }, { node: { kind: 'leaf', id: 'b' }, weight: 0.5 }] } },
      leafMeta: { a: { component: 'terminal', tabComponent: 'terminal', title: 'shell' }, b: { component: 'browser', tabComponent: 'surface', title: 'docs' } },
    },
  };

  it('renames every Surface everywhere it is named', async () => {
    const [fresh] = await withFreshSurfaceIds([session]);
    expect(fresh.panes.map(pane => pane.id)).toEqual(['surface:1', 'surface:2', 'surface:3']);
    expect(fresh.doors).toEqual([expect.objectContaining({
      id: 'surface:3',
      token: expect.objectContaining({ leafId: 'surface:3', siblingId: 'surface:1', siblingLeafIds: ['surface:1', 'gone'] }),
    })]);
    expect(fresh.lathLayout).toMatchObject({
      tree: { root: { children: [{ node: { id: 'surface:1' } }, { node: { id: 'surface:2' } }] } },
      leafMeta: { 'surface:1': { title: 'shell' }, 'surface:2': { title: 'docs' } },
    });
    expect(Object.keys((fresh.lathLayout as { leafMeta: object }).leafMeta)).toEqual(['surface:1', 'surface:2']);
  });

  it('reserves exactly the distinct Surfaces of every session at once, past what the pool holds', async () => {
    let next = 100;
    const reserve = vi.fn(async (count: number) => Array.from({ length: Math.min(count, 64) }, () => `surface:${next++}`));
    await installSurfaceIdPool(reserve, 0);
    reserve.mockClear();
    const sessions = Array.from({ length: 5 }, () => session);
    const fresh = await withFreshSurfaceIds(sessions);
    // Three distinct Surfaces a session, the Door's pane and Door one id.
    const ids = fresh.flatMap((remapped) => remapped.panes.map((pane) => pane.id));
    expect(new Set(ids).size).toBe(15);
    expect(ids.every((id) => /^surface:\d+$/.test(id))).toBe(true);
    // The pool's 8 serve first; the host reserves only the other 7, and then
    // the pool's own refill.
    expect(reserve.mock.calls).toEqual([[7, 0], [7, 0]]);
    expect(mintSurfaceId()).toMatch(/^surface:\d+$/);
  });
});
