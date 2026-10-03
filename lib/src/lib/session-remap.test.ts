import { describe, expect, it } from 'vitest';
import { withFreshSurfaceIds } from './session-remap';
import type { PersistedSession } from './session-types';

describe('withFreshSurfaceIds', () => {
  const session: PersistedSession = {
    version: 3,
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
    surfaceRefs: { a: 'surface:1', b: 'surface:2', door: 'surface:3' },
    surfaceRefsNext: 4,
  };

  it('renames every Surface everywhere it is named, and starts its refs over', () => {
    let n = 0;
    const fresh = withFreshSurfaceIds(session, () => `new-${++n}`);
    expect(fresh.panes.map(pane => pane.id)).toEqual(['new-1', 'new-2', 'new-3']);
    expect(fresh.doors).toEqual([expect.objectContaining({
      id: 'new-3',
      token: expect.objectContaining({ leafId: 'new-3', siblingId: 'new-1', siblingLeafIds: ['new-1', 'gone'] }),
    })]);
    expect(fresh.lathLayout).toMatchObject({
      tree: { root: { children: [{ node: { id: 'new-1' } }, { node: { id: 'new-2' } }] } },
      leafMeta: { 'new-1': { title: 'shell' }, 'new-2': { title: 'docs' } },
    });
    expect(Object.keys((fresh.lathLayout as { leafMeta: object }).leafMeta)).toEqual(['new-1', 'new-2']);
    expect(fresh.surfaceRefs).toBeUndefined();
    expect(fresh.surfaceRefsNext).toBeUndefined();
  });
});
