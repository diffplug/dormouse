import { describe, it, expect } from 'vitest';
import { dockviewLayoutToLath } from './dockview-convert';
import { validate, type LathNode } from './model';
import { dockviewFixture, leafMeta as makeLeafMeta } from './test-fixtures';

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

    expect(leafMeta['pane-a']).toEqual(makeLeafMeta({ component: 'terminal', title: 'A' }));
    expect(leafMeta['pane-b']).toEqual(makeLeafMeta({ component: 'browser', title: 'B', params: { renderMode: 'iframe', url: 'https://example.com' } }));
    expect(leafMeta['pane-c']).toEqual(makeLeafMeta({ component: 'terminal', title: 'C' }));

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
