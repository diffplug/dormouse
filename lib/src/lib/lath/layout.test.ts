import { describe, expect, it } from 'vitest';
import { leafTree } from './model';
import { type LayoutOpts, autoEdge, layout, neighbors, nodeRectAtPath, sashes } from './layout';
import { leaf, split, tree, R } from './test-util';

const noMin: LayoutOpts = { gap: 0, minLeaf: { width: 0, height: 0 } };
const obj = (m: Map<string, unknown>) => Object.fromEntries(m);

describe('layout — golden trees', () => {
  it('3-way row 0.5/0.25/0.25 in 1000×600 gap 4', () => {
    const t = tree(split('row', [leaf('a'), 0.5], [leaf('b'), 0.25], [leaf('c'), 0.25]));
    expect(obj(layout(t, R(0, 0, 1000, 600), { gap: 4, minLeaf: { width: 0, height: 0 } }))).toEqual({
      a: R(0, 0, 496, 600),
      b: R(500, 0, 248, 600),
      c: R(752, 0, 248, 600),
    });
  });

  it('nested col inside a row, gap 0', () => {
    const t = tree(split('row', [leaf('a'), 0.5], [split('col', [leaf('b'), 0.5], [leaf('c'), 0.5]), 0.5]));
    expect(obj(layout(t, R(0, 0, 100, 100), noMin))).toEqual({
      a: R(0, 0, 50, 100),
      b: R(50, 0, 50, 50),
      c: R(50, 50, 50, 50),
    });
  });

  it('thirds in 100px distribute the rounding remainder left-to-right', () => {
    const t = tree(split('row', [leaf('a'), 1 / 3], [leaf('b'), 1 / 3], [leaf('c'), 1 / 3]));
    expect(obj(layout(t, R(0, 0, 100, 10), noMin))).toEqual({
      a: R(0, 0, 33, 10),
      b: R(33, 0, 34, 10),
      c: R(67, 0, 33, 10),
    });
  });

  it('honors minLeaf via waterfill when feasible', () => {
    const t = tree(split('row', [leaf('a'), 0.9], [leaf('b'), 0.1]));
    expect(obj(layout(t, R(0, 0, 100, 20), { gap: 0, minLeaf: { width: 30, height: 0 } }))).toEqual({
      a: R(0, 0, 70, 20),
      b: R(70, 0, 30, 20),
    });
  });

  it('degrades to min-proportional when overconstrained (never overlaps)', () => {
    const t = tree(split('row', [leaf('a'), 0.5], [leaf('b'), 0.5]));
    expect(obj(layout(t, R(0, 0, 50, 50), { gap: 0, minLeaf: { width: 40, height: 0 } }))).toEqual({
      a: R(0, 0, 25, 50),
      b: R(25, 0, 25, 50),
    });
  });

  it('a single leaf fills the rect', () => {
    expect(obj(layout(leafTree('a'), R(5, 7, 100, 50), noMin))).toEqual({ a: R(5, 7, 100, 50) });
  });

  it('does not crash on a zero/negative rect', () => {
    const t = tree(split('row', [leaf('a'), 0.5], [leaf('b'), 0.5]));
    expect(() => layout(t, R(0, 0, 0, 0), { gap: 4, minLeaf: { width: 10, height: 10 } })).not.toThrow();
    const out = layout(t, R(0, 0, 2, 10), { gap: 4, minLeaf: { width: 0, height: 0 } });
    for (const r of out.values()) {
      expect(r.width).toBeGreaterThanOrEqual(0);
      expect(r.height).toBeGreaterThanOrEqual(0);
    }
  });

  it('the empty tree lays out nothing', () => {
    expect(layout(tree(null), R(0, 0, 100, 100), noMin).size).toBe(0);
  });
});

describe('nodeRectAtPath', () => {
  const t = tree(split('row', [leaf('a'), 0.5], [split('col', [leaf('b'), 0.5], [leaf('c'), 0.5]), 0.5]));
  it('returns interior split rects', () => {
    expect(nodeRectAtPath(t, R(0, 0, 100, 100), noMin, [])).toEqual(R(0, 0, 100, 100));
    expect(nodeRectAtPath(t, R(0, 0, 100, 100), noMin, [1])).toEqual(R(50, 0, 50, 100));
    expect(nodeRectAtPath(t, R(0, 0, 100, 100), noMin, [1, 1])).toEqual(R(50, 50, 50, 50));
  });
  it('returns null for a path that leaves the tree', () => {
    expect(nodeRectAtPath(t, R(0, 0, 100, 100), noMin, [9])).toBeNull();
    expect(nodeRectAtPath(t, R(0, 0, 100, 100), noMin, [0, 0])).toBeNull();
  });
});

describe('neighbors — 2×2 grid', () => {
  // Left column col[a,c]; right column col[b,d] → a b / c d.
  const t = tree(
    split(
      'row',
      [split('col', [leaf('a'), 0.5], [leaf('c'), 0.5]), 0.5],
      [split('col', [leaf('b'), 0.5], [leaf('d'), 0.5]), 0.5],
    ),
  );
  const rect = R(0, 0, 100, 100);
  const n = (id: string, dir: 'left' | 'right' | 'up' | 'down') => neighbors(t, rect, id, dir, noMin);

  it('navigates all four directions', () => {
    expect(n('a', 'right')).toBe('b');
    expect(n('a', 'down')).toBe('c');
    expect(n('b', 'left')).toBe('a');
    expect(n('b', 'down')).toBe('d');
    expect(n('c', 'up')).toBe('a');
    expect(n('c', 'right')).toBe('d');
    expect(n('d', 'left')).toBe('c');
    expect(n('d', 'up')).toBe('b');
  });

  it('returns null at the walls', () => {
    expect(n('a', 'left')).toBeNull();
    expect(n('a', 'up')).toBeNull();
    expect(n('d', 'right')).toBeNull();
    expect(n('d', 'down')).toBeNull();
  });

  it('returns null for a missing leaf', () => {
    expect(n('z', 'right')).toBeNull();
  });
});

describe('autoEdge', () => {
  it('splits wide leaves right and tall/square leaves bottom', () => {
    expect(autoEdge(leafTree('a'), R(0, 0, 100, 50), 'a', noMin)).toBe('right');
    expect(autoEdge(leafTree('a'), R(0, 0, 50, 100), 'a', noMin)).toBe('bottom');
    expect(autoEdge(leafTree('a'), R(0, 0, 50, 50), 'a', noMin)).toBe('bottom');
  });
  it('defaults to right for a missing leaf', () => {
    expect(autoEdge(leafTree('a'), R(0, 0, 100, 50), 'z', noMin)).toBe('right');
  });
});

describe('sashes', () => {
  it('reports the gap band of a single split', () => {
    const t = tree(split('row', [leaf('a'), 0.5], [leaf('b'), 0.5]));
    expect(sashes(t, R(0, 0, 100, 100), { gap: 4, minLeaf: { width: 0, height: 0 } })).toEqual([
      { splitPath: [], boundary: 0, dir: 'row', rect: R(48, 0, 4, 100) },
    ]);
  });

  it('reports a zero-thickness band at the shared edge with gap 0, one per split', () => {
    const t = tree(split('row', [leaf('a'), 0.5], [split('col', [leaf('b'), 0.5], [leaf('c'), 0.5]), 0.5]));
    expect(sashes(t, R(0, 0, 100, 100), noMin)).toEqual([
      { splitPath: [], boundary: 0, dir: 'row', rect: R(50, 0, 0, 100) },
      { splitPath: [1], boundary: 0, dir: 'col', rect: R(50, 50, 50, 0) },
    ]);
  });
});
