import { describe, expect, it } from 'vitest';
import { type SerializedDockview } from 'dockview-react';
import { cloneLayout, getLayoutStructureSignature } from './layout-snapshot';

/** Build a minimal dockview-shaped serialized layout. dockview stores branch
 *  children under `data` (an array) and leaf view-membership under `data` (an
 *  object) — the shape `stripSizes` recurses over. */
function leaf(views: string[], size: number) {
  return { type: 'leaf', data: { views, activeView: views[0], id: views[0] }, size };
}

function layout(root: any, panelIds: string[]): SerializedDockview {
  return {
    grid: { root, orientation: 'HORIZONTAL', width: 1000, height: 800 },
    panels: Object.fromEntries(
      panelIds.map(id => [id, { id, contentComponent: 'terminal', params: {} }]),
    ),
    activeGroup: 'g1',
  } as unknown as SerializedDockview;
}

describe('getLayoutStructureSignature', () => {
  it('ignores nested sizes so resizing does not change the signature', () => {
    // A two-pane split. The only difference between the two layouts is the
    // `size` of every node — the shape and panel membership are identical.
    // This is the regression: previously stripSizes returned early on the
    // root branch node (its children live under `data`, which is truthy), so
    // nested sizes leaked into the "structural" signature and a resize
    // silently disabled exact-layout reattach.
    const before = layout(
      { type: 'branch', data: [leaf(['pane-a'], 500), leaf(['pane-b'], 500)], size: 1000 },
      ['pane-a', 'pane-b'],
    );
    const afterResize = layout(
      { type: 'branch', data: [leaf(['pane-a'], 700), leaf(['pane-b'], 300)], size: 1000 },
      ['pane-a', 'pane-b'],
    );

    expect(getLayoutStructureSignature(before)).toBe(
      getLayoutStructureSignature(afterResize),
    );
  });

  it('ignores sizes at arbitrary nesting depth', () => {
    const shallow = layout(
      {
        type: 'branch',
        data: [
          leaf(['pane-a'], 400),
          { type: 'branch', data: [leaf(['pane-b'], 300), leaf(['pane-c'], 300)], size: 600 },
        ],
        size: 1000,
      },
      ['pane-a', 'pane-b', 'pane-c'],
    );
    const resizedDeep = layout(
      {
        type: 'branch',
        data: [
          leaf(['pane-a'], 250),
          { type: 'branch', data: [leaf(['pane-b'], 500), leaf(['pane-c'], 100)], size: 750 },
        ],
        size: 1000,
      },
      ['pane-a', 'pane-b', 'pane-c'],
    );

    expect(getLayoutStructureSignature(shallow)).toBe(
      getLayoutStructureSignature(resizedDeep),
    );
  });

  it('distinguishes a different tree shape', () => {
    const flat = layout(
      { type: 'branch', data: [leaf(['pane-a'], 500), leaf(['pane-b'], 500)], size: 1000 },
      ['pane-a', 'pane-b'],
    );
    const nested = layout(
      {
        type: 'branch',
        data: [{ type: 'branch', data: [leaf(['pane-a'], 500)], size: 500 }, leaf(['pane-b'], 500)],
        size: 1000,
      },
      ['pane-a', 'pane-b'],
    );

    expect(getLayoutStructureSignature(flat)).not.toBe(
      getLayoutStructureSignature(nested),
    );
  });

  it('distinguishes different panel membership', () => {
    const ab = layout(
      { type: 'branch', data: [leaf(['pane-a'], 500), leaf(['pane-b'], 500)], size: 1000 },
      ['pane-a', 'pane-b'],
    );
    const ac = layout(
      { type: 'branch', data: [leaf(['pane-a'], 500), leaf(['pane-c'], 500)], size: 1000 },
      ['pane-a', 'pane-c'],
    );

    expect(getLayoutStructureSignature(ab)).not.toBe(
      getLayoutStructureSignature(ac),
    );
  });

  it('distinguishes which leaf a panel is grouped into', () => {
    const grouped = layout(
      { type: 'branch', data: [leaf(['pane-a', 'pane-b'], 1000)], size: 1000 },
      ['pane-a', 'pane-b'],
    );
    const split = layout(
      { type: 'branch', data: [leaf(['pane-a'], 500), leaf(['pane-b'], 500)], size: 1000 },
      ['pane-a', 'pane-b'],
    );

    expect(getLayoutStructureSignature(grouped)).not.toBe(
      getLayoutStructureSignature(split),
    );
  });

  it('is independent of panel key ordering', () => {
    const forward = layout(
      { type: 'branch', data: [leaf(['pane-a'], 500), leaf(['pane-b'], 500)], size: 1000 },
      ['pane-a', 'pane-b'],
    );
    const reversed = layout(
      { type: 'branch', data: [leaf(['pane-a'], 500), leaf(['pane-b'], 500)], size: 1000 },
      ['pane-b', 'pane-a'],
    );

    expect(getLayoutStructureSignature(forward)).toBe(
      getLayoutStructureSignature(reversed),
    );
  });
});

describe('cloneLayout', () => {
  it('deep-clones so mutations do not leak back', () => {
    const original = layout(
      { type: 'branch', data: [leaf(['pane-a'], 500)], size: 1000 },
      ['pane-a'],
    );
    const clone = cloneLayout(original);
    (clone.grid.root as any).size = 42;
    expect((original.grid.root as any).size).toBe(1000);
  });
});
