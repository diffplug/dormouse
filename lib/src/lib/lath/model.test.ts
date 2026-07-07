import { describe, expect, it } from 'vitest';
import {
  type LathNode,
  type LathTree,
  edgeAxis,
  edgeIsBefore,
  findLeafPath,
  leafTree,
  leaves,
  nodeAtPath,
  normalize,
  normalizeWeights,
  replaceAtPath,
  structureFingerprint,
  validate,
} from './model';

const leaf = (id: string): LathNode => ({ kind: 'leaf', id });
const split = (dir: 'row' | 'col', ...children: Array<[LathNode, number]>): LathNode => ({
  kind: 'split',
  dir,
  children: children.map(([node, weight]) => ({ node, weight })),
});
const tree = (root: LathNode | null): LathTree => ({ root });

describe('leafTree', () => {
  it('seeds a single-leaf tree', () => {
    expect(leafTree('a')).toEqual({ root: { kind: 'leaf', id: 'a' } });
    expect(validate(leafTree('a'))).toEqual([]);
  });
});

describe('leaves / findLeafPath / nodeAtPath', () => {
  const t = tree(split('row', [leaf('a'), 0.5], [split('col', [leaf('b'), 0.5], [leaf('c'), 0.5]), 0.5]));

  it('lists leaves in pre-order', () => {
    expect(leaves(t)).toEqual(['a', 'b', 'c']);
    expect(leaves(tree(null))).toEqual([]);
  });

  it('finds leaf paths', () => {
    expect(findLeafPath(t, 'a')).toEqual([0]);
    expect(findLeafPath(t, 'b')).toEqual([1, 0]);
    expect(findLeafPath(t, 'c')).toEqual([1, 1]);
    expect(findLeafPath(t, 'z')).toBeNull();
  });

  it('resolves nodes at paths', () => {
    expect(nodeAtPath(t, [])).toBe(t.root);
    expect(nodeAtPath(t, [0])).toEqual(leaf('a'));
    expect((nodeAtPath(t, [1]) as { kind: string }).kind).toBe('split');
    expect(nodeAtPath(t, [1, 1])).toEqual(leaf('c'));
    expect(nodeAtPath(t, [5])).toBeNull();
    expect(nodeAtPath(t, [0, 0])).toBeNull(); // through a leaf
  });
});

describe('validate', () => {
  it('accepts valid trees and the empty tree', () => {
    expect(validate(tree(null))).toEqual([]);
    expect(validate(tree(leaf('a')))).toEqual([]);
    expect(validate(tree(split('row', [leaf('a'), 0.3], [leaf('b'), 0.7])))).toEqual([]);
  });

  it('flags a split with fewer than 2 children', () => {
    expect(validate(tree(split('row', [leaf('a'), 1]))).join()).toMatch(/< 2/);
  });

  it('flags a same-direction nested split', () => {
    const bad = tree(split('row', [leaf('a'), 0.5], [split('row', [leaf('b'), 0.5], [leaf('c'), 0.5]), 0.5]));
    expect(validate(bad).join()).toMatch(/same-direction/);
  });

  it('flags non-positive weights', () => {
    expect(validate(tree(split('row', [leaf('a'), 0], [leaf('b'), 1]))).join()).toMatch(/non-positive/);
  });

  it('flags weights that do not sum to 1', () => {
    expect(validate(tree(split('row', [leaf('a'), 0.5], [leaf('b'), 0.9]))).join()).toMatch(/sum to/);
  });

  it('tolerates tiny weight drift', () => {
    expect(validate(tree(split('row', [leaf('a'), 1 / 3], [leaf('b'), 1 / 3], [leaf('c'), 1 / 3])))).toEqual([]);
  });

  it('flags duplicate leaf ids', () => {
    expect(validate(tree(split('row', [leaf('a'), 0.5], [leaf('a'), 0.5]))).join()).toMatch(/duplicate/);
  });
});

describe('normalizeWeights', () => {
  it('rescales to sum 1 preserving proportions', () => {
    const out = normalizeWeights([
      { node: leaf('a'), weight: 1 },
      { node: leaf('b'), weight: 3 },
    ]);
    expect(out.map((c) => c.weight)).toEqual([0.25, 0.75]);
  });

  it('falls back to equal weights when the sum is non-positive', () => {
    const out = normalizeWeights([
      { node: leaf('a'), weight: 0 },
      { node: leaf('b'), weight: 0 },
    ]);
    expect(out.map((c) => c.weight)).toEqual([0.5, 0.5]);
  });
});

describe('normalize', () => {
  it('leaves a plain leaf untouched', () => {
    const l = leaf('a');
    expect(normalize(l)).toBe(l);
  });

  it('flattens a same-direction child split, scaling its children by the child weight', () => {
    // row[ a:0.5, row[b:0.5, c:0.5]:0.5 ] → row[a:0.5, b:0.25, c:0.25]
    const n = normalize(split('row', [leaf('a'), 0.5], [split('row', [leaf('b'), 0.5], [leaf('c'), 0.5]), 0.5]));
    expect(validate(tree(n))).toEqual([]);
    expect(n).toEqual(split('row', [leaf('a'), 0.5], [leaf('b'), 0.25], [leaf('c'), 0.25]));
  });

  it('collapses a single-child split to its child', () => {
    expect(normalize(split('row', [leaf('a'), 1]))).toEqual(leaf('a'));
    // nested single-child collapse
    expect(normalize(split('row', [split('col', [leaf('a'), 1]), 1]))).toEqual(leaf('a'));
  });

  it('keeps a cross-direction nested split', () => {
    const n = split('row', [leaf('a'), 0.5], [split('col', [leaf('b'), 0.5], [leaf('c'), 0.5]), 0.5]);
    expect(normalize(n)).toEqual(n);
  });

  it('renormalizes weights that do not sum to 1', () => {
    const n = normalize(split('row', [leaf('a'), 2], [leaf('b'), 2]));
    expect(n).toEqual(split('row', [leaf('a'), 0.5], [leaf('b'), 0.5]));
  });
});

describe('edgeAxis / edgeIsBefore', () => {
  it('maps edges to axes', () => {
    expect(edgeAxis('left')).toBe('row');
    expect(edgeAxis('right')).toBe('row');
    expect(edgeAxis('top')).toBe('col');
    expect(edgeAxis('bottom')).toBe('col');
  });
  it('marks before-edges', () => {
    expect(edgeIsBefore('left')).toBe(true);
    expect(edgeIsBefore('top')).toBe(true);
    expect(edgeIsBefore('right')).toBe(false);
    expect(edgeIsBefore('bottom')).toBe(false);
  });
});

describe('replaceAtPath', () => {
  const root = split('row', [leaf('a'), 0.5], [split('col', [leaf('b'), 0.5], [leaf('c'), 0.5]), 0.5]);

  it('replaces the whole tree at the empty path', () => {
    expect(replaceAtPath(root, [], leaf('z'))).toEqual(leaf('z'));
  });

  it('replaces a nested node and shares untouched siblings', () => {
    const out = replaceAtPath(root, [1, 0], leaf('z'));
    expect(findLeafPath(tree(out), 'z')).toEqual([1, 0]);
    expect(findLeafPath(tree(out), 'c')).toEqual([1, 1]);
    // 'a' subtree object is shared (structural sharing outside the spine).
    const kids = (n: LathNode) => (n as { children: Array<{ node: LathNode }> }).children;
    expect(kids(out)[0].node).toBe(kids(root)[0].node);
  });
});

describe('structureFingerprint', () => {
  it('is weight-independent but structure- and id-sensitive', () => {
    const a = split('row', [leaf('a'), 0.5], [leaf('b'), 0.5]);
    const b = split('row', [leaf('a'), 0.2], [leaf('b'), 0.8]);
    const c = split('row', [leaf('a'), 0.5], [leaf('x'), 0.5]);
    const d = split('col', [leaf('a'), 0.5], [leaf('b'), 0.5]);
    expect(structureFingerprint(a)).toBe(structureFingerprint(b));
    expect(structureFingerprint(a)).not.toBe(structureFingerprint(c));
    expect(structureFingerprint(a)).not.toBe(structureFingerprint(d));
  });
});
