import { describe, it, expect } from 'vitest';
import {
  dockviewLayoutToLath,
  lathLayoutFromStore,
  lathToDockviewLayout,
  type LathPersistedLayout,
} from './lath-dockview-convert';
import { validate, type LathNode, type LathTree } from '../../lib/lath/model';
import type { LeafMeta } from './lath-wall-store';

// A hand-written blob matching dockview-core's serialized shape (SerializedDockview):
// grid.orientation is the ROOT orientation; a HORIZONTAL branch lays children
// left→right; each child's `size` is its extent along the parent axis; leaf `data`
// is a group ({ id, views, activeView }); panel state lives in the flat `panels` map.
function dockviewFixture(): unknown {
  return {
    grid: {
      root: {
        type: 'branch',
        data: [
          { type: 'leaf', data: { id: 'group-1', views: ['pane-a'], activeView: 'pane-a' }, size: 600 },
          {
            type: 'branch',
            data: [
              { type: 'leaf', data: { id: 'group-2', views: ['pane-b'], activeView: 'pane-b' }, size: 300 },
              { type: 'leaf', data: { id: 'group-3', views: ['pane-c'], activeView: 'pane-c' }, size: 500 },
            ],
            size: 400,
          },
        ],
        size: 800,
      },
      width: 1000,
      height: 800,
      orientation: 'HORIZONTAL',
    },
    panels: {
      'pane-a': { id: 'pane-a', contentComponent: 'terminal', tabComponent: 'terminal', title: 'A' },
      'pane-b': {
        id: 'pane-b',
        contentComponent: 'browser',
        tabComponent: 'surface',
        title: 'B',
        renderer: 'always',
        params: { renderMode: 'iframe', url: 'https://example.com' },
      },
      'pane-c': { id: 'pane-c', contentComponent: 'terminal', tabComponent: 'terminal', title: 'C' },
    },
    activeGroup: 'group-1',
  };
}

/** Assert two trees are structurally identical with weights within `tol`. */
function expectTreesClose(a: LathTree, b: LathTree, tol = 1e-3): void {
  const walk = (x: LathNode | null, y: LathNode | null): void => {
    expect(x?.kind).toBe(y?.kind);
    if (!x || !y) return;
    if (x.kind === 'leaf' && y.kind === 'leaf') {
      expect(x.id).toBe(y.id);
      return;
    }
    if (x.kind === 'split' && y.kind === 'split') {
      expect(x.dir).toBe(y.dir);
      expect(x.children.length).toBe(y.children.length);
      x.children.forEach((c, i) => {
        expect(Math.abs(c.weight - y.children[i].weight)).toBeLessThan(tol);
        walk(c.node, y.children[i].node);
      });
    }
  };
  walk(a.root, b.root);
}

function m(component: string, tabComponent: string, title: string, params?: Record<string, unknown>): LeafMeta {
  return { component, tabComponent, title, ...(params ? { params } : {}) };
}

describe('dockviewLayoutToLath — real-shaped blob', () => {
  it('maps orientation-by-depth to split dirs, sizes to normalized weights, panels to meta', () => {
    const layout = dockviewLayoutToLath(dockviewFixture());
    expect(layout).not.toBeNull();
    const { tree, leafMeta } = layout!;

    // Root HORIZONTAL branch → 'row'; nested branch (orthogonal) → 'col'.
    expect(tree.root?.kind).toBe('split');
    const root = tree.root as Extract<LathNode, { kind: 'split' }>;
    expect(root.dir).toBe('row');
    // sizes 600 / 400 → weights 0.6 / 0.4.
    expect(root.children[0].weight).toBeCloseTo(0.6, 5);
    expect(root.children[1].weight).toBeCloseTo(0.4, 5);
    expect(root.children[0].node).toEqual({ kind: 'leaf', id: 'pane-a' });

    const nested = root.children[1].node as Extract<LathNode, { kind: 'split' }>;
    expect(nested.dir).toBe('col');
    // sizes 300 / 500 → weights 0.375 / 0.625.
    expect(nested.children[0].weight).toBeCloseTo(0.375, 5);
    expect(nested.children[1].weight).toBeCloseTo(0.625, 5);

    expect(leafMeta['pane-a']).toEqual(m('terminal', 'terminal', 'A'));
    expect(leafMeta['pane-b']).toEqual(m('browser', 'surface', 'B', { renderMode: 'iframe', url: 'https://example.com' }));
    expect(leafMeta['pane-c']).toEqual(m('terminal', 'terminal', 'C'));

    expect(validate(tree)).toEqual([]);
  });
});

describe('dockviewLayoutToLath — legacy alias mapping', () => {
  it('maps iframe / agent-browser content components to the unified browser body', () => {
    const blob = {
      grid: {
        root: {
          type: 'branch',
          data: [
            { type: 'leaf', data: { id: 'g1', views: ['p1'] }, size: 1 },
            { type: 'leaf', data: { id: 'g2', views: ['p2'] }, size: 1 },
          ],
          size: 1,
        },
        width: 100,
        height: 100,
        orientation: 'HORIZONTAL',
      },
      panels: {
        p1: { id: 'p1', contentComponent: 'iframe', title: 'legacy iframe' },
        p2: { id: 'p2', contentComponent: 'agent-browser', title: 'legacy ab' },
      },
    };
    const layout = dockviewLayoutToLath(blob)!;
    expect(layout.leafMeta['p1'].component).toBe('browser');
    // No explicit tabComponent → defaults to 'surface' for a browser body.
    expect(layout.leafMeta['p1'].tabComponent).toBe('surface');
    expect(layout.leafMeta['p2'].component).toBe('browser');
  });
});

describe('dockviewLayoutToLath — multi-view group degradation', () => {
  it('degrades an n-view group to one leaf per view (Dormouse never tab-stacks)', () => {
    const blob = {
      grid: {
        root: {
          type: 'branch',
          data: [
            { type: 'leaf', data: { id: 'g1', views: ['solo'] }, size: 500 },
            { type: 'leaf', data: { id: 'g2', views: ['v1', 'v2'] }, size: 500 },
          ],
          size: 800,
        },
        width: 1000,
        height: 800,
        orientation: 'HORIZONTAL',
      },
      panels: {
        solo: { id: 'solo', contentComponent: 'terminal' },
        v1: { id: 'v1', contentComponent: 'terminal' },
        v2: { id: 'v2', contentComponent: 'terminal' },
      },
    };
    const layout = dockviewLayoutToLath(blob)!;
    expect(new Set(Object.keys(layout.leafMeta))).toEqual(new Set(['solo', 'v1', 'v2']));
    const root = layout.tree.root as Extract<LathNode, { kind: 'split' }>;
    // solo stays a leaf; the 2-view group becomes a split of its two views.
    expect(root.children[0].node).toEqual({ kind: 'leaf', id: 'solo' });
    expect(root.children[1].node.kind).toBe('split');
    expect(validate(layout.tree)).toEqual([]);
  });
});

describe('dockviewLayoutToLath — malformed blobs', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'nope'],
    ['no grid', {}],
    ['no root', { grid: { width: 1, height: 1, orientation: 'HORIZONTAL' } }],
    ['empty branch', { grid: { root: { type: 'branch', data: [] }, width: 1, height: 1, orientation: 'HORIZONTAL' } }],
    ['empty group', { grid: { root: { type: 'leaf', data: { id: 'g', views: [] } }, width: 1, height: 1, orientation: 'HORIZONTAL' } }],
    ['bad node type', { grid: { root: { type: 'weird', data: [] }, width: 1, height: 1, orientation: 'HORIZONTAL' } }],
  ])('returns null for %s', (_label, blob) => {
    expect(dockviewLayoutToLath(blob)).toBeNull();
  });

  it('returns null when the tree fails validation (duplicate leaf ids)', () => {
    const blob = {
      grid: {
        root: {
          type: 'branch',
          data: [
            { type: 'leaf', data: { id: 'g1', views: ['dup'] }, size: 1 },
            { type: 'leaf', data: { id: 'g2', views: ['dup'] }, size: 1 },
          ],
          size: 1,
        },
        width: 1,
        height: 1,
        orientation: 'HORIZONTAL',
      },
      panels: { dup: { id: 'dup', contentComponent: 'terminal' } },
    };
    expect(dockviewLayoutToLath(blob)).toBeNull();
  });
});

describe('lathToDockviewLayout — shape', () => {
  it('emits a valid dockview shape: branch root, matching orientation, renderer:always for browsers', () => {
    const layout: LathPersistedLayout = {
      version: 1,
      tree: {
        root: {
          kind: 'split',
          dir: 'row',
          children: [
            { node: { kind: 'leaf', id: 'a' }, weight: 0.5 },
            { node: { kind: 'leaf', id: 'b' }, weight: 0.5 },
          ],
        },
      },
      leafMeta: {
        a: m('terminal', 'terminal', 'A'),
        b: m('browser', 'surface', 'B', { url: 'x' }),
      },
    };
    const dv = lathToDockviewLayout(layout) as any;
    expect(dv.grid.root.type).toBe('branch');
    expect(dv.grid.orientation).toBe('HORIZONTAL'); // root dir 'row'
    expect(new Set(Object.keys(dv.panels))).toEqual(new Set(['a', 'b']));
    expect(dv.panels.a.renderer).toBeUndefined(); // terminals default renderer
    expect(dv.panels.b.renderer).toBe('always'); // browsers pin renderer:always
    expect(dv.panels.b.params).toEqual({ url: 'x' });
    // Each single-view group carries activeView; grid dims come from the sizeHint.
    expect(dv.grid.width).toBe(1000);
    expect(dv.grid.height).toBe(800);
  });

  it('wraps a single-leaf tree so the root is still a branch', () => {
    const dv = lathToDockviewLayout({
      version: 1,
      tree: { root: { kind: 'leaf', id: 'solo' } },
      leafMeta: { solo: m('terminal', 'terminal', 'Solo') },
    }) as any;
    expect(dv.grid.root.type).toBe('branch');
    expect(dv.grid.root.data).toHaveLength(1);
    expect(dv.grid.root.data[0].type).toBe('leaf');
    expect(dv.grid.root.data[0].data.views).toEqual(['solo']);
  });
});

describe('round-trips', () => {
  it('lath → dockview → lath is exact on a normalized tree (weights within 1e-3)', () => {
    const layout: LathPersistedLayout = {
      version: 1,
      tree: {
        root: {
          kind: 'split',
          dir: 'row',
          children: [
            { node: { kind: 'leaf', id: 'a' }, weight: 0.3 },
            {
              node: {
                kind: 'split',
                dir: 'col',
                children: [
                  { node: { kind: 'leaf', id: 'b' }, weight: 0.4 },
                  { node: { kind: 'leaf', id: 'c' }, weight: 0.6 },
                ],
              },
              weight: 0.7,
            },
          ],
        },
      },
      leafMeta: {
        a: m('terminal', 'terminal', 'A'),
        b: m('browser', 'surface', 'B', { url: 'x' }),
        c: m('terminal', 'terminal', 'C'),
      },
    };
    const back = dockviewLayoutToLath(lathToDockviewLayout(layout));
    expect(back).not.toBeNull();
    expectTreesClose(back!.tree, layout.tree, 1e-3);
    expect(back!.leafMeta).toEqual(layout.leafMeta);
  });

  it('dockview → lath → dockview preserves structure, panel set, and ~sizes', () => {
    const original = dockviewFixture() as any;
    const lath = dockviewLayoutToLath(original)!;
    const dv = lathToDockviewLayout(lath) as any;

    // Same panel set.
    expect(new Set(Object.keys(dv.panels))).toEqual(new Set(Object.keys(original.panels)));
    // Same top-level structure: HORIZONTAL root with two children (leaf, branch).
    expect(dv.grid.orientation).toBe('HORIZONTAL');
    expect(dv.grid.root.type).toBe('branch');
    expect(dv.grid.root.data).toHaveLength(2);
    expect(dv.grid.root.data[0].type).toBe('leaf');
    expect(dv.grid.root.data[1].type).toBe('branch');
    // ~sizes: first child ≈ 60% of width (original 600/1000).
    const w0 = dv.grid.root.data[0].size;
    const w1 = dv.grid.root.data[1].size;
    expect(w0 / (w0 + w1)).toBeCloseTo(0.6, 2);
  });
});

describe('lathLayoutFromStore', () => {
  it('serializes a store snapshot to the persisted layout', () => {
    const tree: LathTree = { root: { kind: 'leaf', id: 'a' } };
    const leafMeta = new Map<string, LeafMeta>([['a', m('terminal', 'terminal', 'A')]]);
    const out = lathLayoutFromStore({ tree, leafMeta });
    expect(out).toEqual({ version: 1, tree, leafMeta: { a: m('terminal', 'terminal', 'A') } });
  });
});
