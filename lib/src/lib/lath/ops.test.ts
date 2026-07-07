import { describe, expect, it } from 'vitest';
import { type LathTree, findLeafPath, leafTree, leaves, validate } from './model';
import { type LayoutOpts, layout } from './layout';
import { insert, move, remove, replace, resize, restore, split, swap } from './ops';
// `split` here is the op; the test-util split node-builder is aliased to `mk`.
import { leaf, split as mk, tree, R } from './test-util';

const opts: LayoutOpts = { gap: 0, minLeaf: { width: 0, height: 0 } };
const rects = (t: LathTree, r = R(0, 0, 100, 100), o = opts) => Object.fromEntries(layout(t, r, o));

describe('split', () => {
  it('splits the root leaf on each edge', () => {
    expect(split(leafTree('a'), 'a', 'right', 'b').tree).toEqual(tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5])));
    expect(split(leafTree('a'), 'a', 'left', 'b').tree).toEqual(tree(mk('row', [leaf('b'), 0.5], [leaf('a'), 0.5])));
    expect(split(leafTree('a'), 'a', 'bottom', 'b').tree).toEqual(tree(mk('col', [leaf('a'), 0.5], [leaf('b'), 0.5])));
    expect(split(leafTree('a'), 'a', 'top', 'b').tree).toEqual(tree(mk('col', [leaf('b'), 0.5], [leaf('a'), 0.5])));
  });

  it('extends the parent split (flatten) when directions match, halving at’s weight', () => {
    const t = tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5]));
    const out = split(t, 'a', 'right', 'c');
    expect(out.ok).toBe(true);
    expect(out.tree).toEqual(tree(mk('row', [leaf('a'), 0.25], [leaf('c'), 0.25], [leaf('b'), 0.5])));
    expect(validate(out.tree)).toEqual([]);
  });

  it('nests a new split when directions differ', () => {
    const t = tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5]));
    const out = split(t, 'a', 'bottom', 'c');
    expect(out.tree).toEqual(tree(mk('row', [mk('col', [leaf('a'), 0.5], [leaf('c'), 0.5]), 0.5], [leaf('b'), 0.5])));
  });

  it('rejects unknown at / duplicate newId / empty tree, returning the same object', () => {
    const t = tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5]));
    const bad = split(t, 'z', 'right', 'c');
    expect(bad.ok).toBe(false);
    expect(bad.tree).toBe(t);
    expect(split(t, 'a', 'right', 'b').ok).toBe(false); // b already exists
    const empty = tree(null);
    expect(split(empty, 'a', 'right', 'b')).toEqual({ tree: empty, ok: false });
  });
});

describe('remove', () => {
  it('collapses a single-child split and reports a right/bottom token for a before-sibling', () => {
    const t = tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5]));
    const out = remove(t, 'b');
    expect(out.ok).toBe(true);
    expect(out.tree).toEqual(leafTree('a'));
    expect(out.token).toMatchObject({ leafId: 'b', weight: 0.5, siblingId: 'a', edge: 'right', index: 1 });
    expect(out.token?.fingerprint).not.toBeNull();
  });

  it('reports a left/top token for an after-sibling', () => {
    const t = tree(mk('col', [leaf('a'), 0.5], [leaf('b'), 0.5]));
    const out = remove(t, 'a');
    expect(out.tree).toEqual(leafTree('b'));
    expect(out.token).toMatchObject({ siblingId: 'b', edge: 'top', index: 0 });
  });

  it('records the adjacent sibling subtree when that sibling is split', () => {
    const t = tree(mk('row', [leaf('a'), 0.4], [mk('col', [leaf('b'), 0.5], [leaf('c'), 0.5]), 0.6]));
    const out = remove(t, 'a');

    expect(out.token).toMatchObject({
      leafId: 'a',
      siblingId: 'b',
      siblingLeafIds: ['b', 'c'],
      edge: 'left',
      index: 0,
    });
    expect(out.token?.siblingFingerprint).toBeTruthy();
  });

  it('absorbs weight proportionally among survivors', () => {
    const t = tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.25], [leaf('c'), 0.25]));
    const out = remove(t, 'b');
    expect(validate(out.tree)).toEqual([]);
    expect(leaves(out.tree)).toEqual(['a', 'c']);
    // a keeps twice c's share (0.5 : 0.25).
    expect(rects(out.tree, R(0, 0, 900, 100))).toEqual({ a: R(0, 0, 600, 100), c: R(600, 0, 300, 100) });
  });

  it('empties the tree and nulls the token fields when removing the root leaf', () => {
    const out = remove(leafTree('a'), 'a');
    expect(out.tree).toEqual(tree(null));
    expect(out.token).toEqual({ leafId: 'a', weight: 1, siblingId: null, edge: 'right', index: 0, fingerprint: null });
  });

  it('rejects an unknown leaf, returning the same object', () => {
    const t = tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5]));
    const out = remove(t, 'z');
    expect(out).toEqual({ tree: t, ok: false, token: null });
    expect(out.tree).toBe(t);
  });
});

describe('replace', () => {
  it('swaps an identity in place', () => {
    const t = tree(mk('row', [leaf('a'), 0.3], [leaf('b'), 0.7]));
    const out = replace(t, 'a', 'c');
    expect(out.ok).toBe(true);
    expect(out.tree).toEqual(tree(mk('row', [leaf('c'), 0.3], [leaf('b'), 0.7])));
  });

  it('rejects unknown old / existing new', () => {
    const t = tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5]));
    expect(replace(t, 'z', 'c').ok).toBe(false);
    expect(replace(t, 'a', 'b').ok).toBe(false);
    expect(replace(t, 'z', 'c').tree).toBe(t);
  });
});

describe('swap', () => {
  it('exchanges two leaf identities, keeping weights fixed to position', () => {
    const t = tree(mk('row', [leaf('a'), 0.3], [leaf('b'), 0.7]));
    const out = swap(t, 'a', 'b');
    expect(out.tree).toEqual(tree(mk('row', [leaf('b'), 0.3], [leaf('a'), 0.7])));
  });

  it('rejects a === b and unknown leaves', () => {
    const t = tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5]));
    expect(swap(t, 'a', 'a')).toEqual({ tree: t, ok: false });
    expect(swap(t, 'a', 'z').ok).toBe(false);
    expect(swap(t, 'a', 'a').tree).toBe(t);
  });
});

describe('move', () => {
  it('a swap target defers to swap', () => {
    const t = tree(mk('row', [leaf('a'), 0.3], [leaf('b'), 0.7]));
    expect(move(t, 'a', { kind: 'swap', leaf: 'b' }).tree).toEqual(swap(t, 'a', 'b').tree);
    expect(move(t, 'a', { kind: 'swap', leaf: 'a' })).toEqual({ tree: t, ok: false });
  });

  it('moves a leaf beside another leaf, weight following the leaf', () => {
    const t = tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5]));
    const out = move(t, 'a', { kind: 'edge', path: findLeafPath(t, 'b')!, edge: 'right' });
    expect(out.ok).toBe(true);
    expect(validate(out.tree)).toEqual([]);
    expect(leaves(out.tree).sort()).toEqual(['a', 'b']);
    // a now sits to the right of b.
    const r = rects(out.tree);
    expect(r.a.x).toBeGreaterThanOrEqual(r.b.x + r.b.width);
  });

  it('moves a leaf beside an ancestor split (“beside the whole column”)', () => {
    const t = tree(mk('row', [leaf('a'), 0.5], [mk('col', [leaf('b'), 0.5], [leaf('c'), 0.5]), 0.5]));
    const out = move(t, 'a', { kind: 'edge', path: [1], edge: 'right' });
    expect(out.ok).toBe(true);
    expect(out.tree).toEqual(tree(mk('row', [mk('col', [leaf('b'), 0.5], [leaf('c'), 0.5]), 0.5], [leaf('a'), 0.5])));
    // a spans the full height as a column to the right of b/c.
    const r = rects(out.tree);
    expect(r.a.height).toBe(100);
    expect(r.a.x).toBeGreaterThan(r.b.x);
  });

  it('rejects: unknown id, invalid path, dragging the whole target subtree, self', () => {
    const t = tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5]));
    expect(move(t, 'z', { kind: 'edge', path: [1], edge: 'left' }).ok).toBe(false);
    expect(move(t, 'a', { kind: 'edge', path: [9], edge: 'left' }).ok).toBe(false);
    // target is a's own leaf → nothing to be beside.
    expect(move(t, 'a', { kind: 'edge', path: findLeafPath(t, 'a')!, edge: 'left' }).ok).toBe(false);
    // single-leaf tree relative to itself.
    expect(move(leafTree('a'), 'a', { kind: 'edge', path: [], edge: 'left' }).ok).toBe(false);
    expect(move(t, 'z', { kind: 'edge', path: [1], edge: 'left' }).tree).toBe(t);
  });
});

describe('insert', () => {
  it('inserts a new leaf beside a leaf at the default 0.5 split', () => {
    const out = insert(leafTree('a'), 'b', { kind: 'edge', path: [], edge: 'right' });
    expect(out.ok).toBe(true);
    expect(out.tree).toEqual(tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5])));
    expect(validate(out.tree)).toEqual([]);
  });

  it('inserts beside an ancestor split ("beside the whole column")', () => {
    const t = tree(mk('col', [leaf('b'), 0.5], [leaf('c'), 0.5]));
    const out = insert(t, 'a', { kind: 'edge', path: [], edge: 'right' });
    expect(out.tree).toEqual(tree(mk('row', [mk('col', [leaf('b'), 0.5], [leaf('c'), 0.5]), 0.5], [leaf('a'), 0.5])));
  });

  it('carries a raw weight into a nested insert (the moved-leaf weight rule)', () => {
    // weight 0.75 → the new leaf takes 0.75, the displaced subtree the 0.25 complement.
    const out = insert(leafTree('a'), 'b', { kind: 'edge', path: [], edge: 'right' }, 0.75);
    expect(out.tree).toEqual(tree(mk('row', [leaf('a'), 0.25], [leaf('b'), 0.75])));
    expect(validate(out.tree)).toEqual([]);
  });

  it('clamps an out-of-range weight into a valid tree', () => {
    const out = insert(leafTree('a'), 'b', { kind: 'edge', path: [], edge: 'right' }, 5);
    expect(out.ok).toBe(true);
    expect(validate(out.tree)).toEqual([]);
    // a keeps a hairline positive weight; b takes essentially all of it.
    const w = rects(out.tree, R(0, 0, 100, 100), { gap: 0, minLeaf: { width: 0, height: 0 } });
    expect(w.b.width).toBeGreaterThan(w.a.width);
  });

  it('rejects: swap target, existing id, empty tree, path off the tree', () => {
    const t = tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5]));
    expect(insert(t, 'c', { kind: 'swap', leaf: 'a' })).toEqual({ tree: t, ok: false });
    expect(insert(t, 'a', { kind: 'edge', path: [0], edge: 'right' })).toEqual({ tree: t, ok: false });
    expect(insert(tree(null), 'a', { kind: 'edge', path: [], edge: 'right' })).toEqual({ tree: tree(null), ok: false });
    expect(insert(t, 'c', { kind: 'edge', path: [9], edge: 'right' })).toEqual({ tree: t, ok: false });
  });
});

describe('resize', () => {
  const t = tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5]));
  const rect = R(0, 0, 100, 100);

  it('converts a px delta into weight, both directions', () => {
    expect(rects(resize(t, [], 0, 10, rect, opts).tree)).toEqual({ a: R(0, 0, 60, 100), b: R(60, 0, 40, 100) });
    expect(rects(resize(t, [], 0, -10, rect, opts).tree)).toEqual({ a: R(0, 0, 40, 100), b: R(40, 0, 60, 100) });
  });

  it('clamps against minLeaf in both directions', () => {
    const min: LayoutOpts = { gap: 0, minLeaf: { width: 30, height: 0 } };
    expect(rects(resize(t, [], 0, 1000, rect, min).tree, rect, min)).toEqual({
      a: R(0, 0, 70, 100),
      b: R(70, 0, 30, 100),
    });
    expect(rects(resize(t, [], 0, -1000, rect, min).tree, rect, min)).toEqual({
      a: R(0, 0, 30, 100),
      b: R(30, 0, 70, 100),
    });
  });

  it('a zero delta is an ok no-op', () => {
    const out = resize(t, [], 0, 0, rect, opts);
    expect(out.ok).toBe(true);
    expect(rects(out.tree)).toEqual({ a: R(0, 0, 50, 100), b: R(50, 0, 50, 100) });
  });

  it('rejects invalid path, boundary out of range, and zero-size span', () => {
    expect(resize(t, [9], 0, 10, rect, opts).ok).toBe(false);
    expect(resize(t, [], 5, 10, rect, opts).ok).toBe(false);
    expect(resize(t, [], 0, 10, R(0, 0, 0, 100), opts).ok).toBe(false);
    expect(resize(t, [9], 0, 10, rect, opts).tree).toBe(t);
  });

  it('resizes a nested split by its path', () => {
    const nested = tree(mk('row', [leaf('a'), 0.5], [mk('col', [leaf('b'), 0.5], [leaf('c'), 0.5]), 0.5]));
    const out = resize(nested, [1], 0, 10, R(0, 0, 100, 100), opts);
    expect(out.ok).toBe(true);
    // The inner col occupies the right half (x 50..100, full height); its boundary shifts down 10px.
    const r = rects(out.tree);
    expect(r.b).toEqual(R(50, 0, 50, 60));
    expect(r.c).toEqual(R(50, 60, 50, 40));
  });
});

describe('restore', () => {
  const big = R(0, 0, 1000, 600);

  it('restores exact when the fingerprinted parent is untouched', () => {
    const original = tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.25], [leaf('c'), 0.25]));
    const removed = remove(original, 'b');
    const out = restore(removed.tree, removed.token!);
    expect(out.tier).toBe('exact');
    expect(validate(out.tree)).toEqual([]);
    expect(leaves(out.tree)).toEqual(['a', 'b', 'c']);
    // Same integer layout as the original — index and weight recovered.
    expect(rects(out.tree, big)).toEqual(rects(original, big));
  });

  it('degrades to neighbor when the surrounding structure changed', () => {
    const original = tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.25], [leaf('c'), 0.25]));
    const removed = remove(original, 'b');
    // Change structure around the sibling 'a' so the fingerprint no longer matches.
    const changed = split(removed.tree, 'a', 'bottom', 'd').tree;
    const out = restore(changed, removed.token!);
    expect(out.tier).toBe('neighbor');
    expect(validate(out.tree)).toEqual([]);
    expect(leaves(out.tree).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('degrades to neighbor for a two-child collapse (sibling survives, fingerprint cannot match)', () => {
    const original = tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5]));
    const removed = remove(original, 'b'); // collapses to leaf a
    const out = restore(removed.tree, removed.token!);
    expect(out.tier).toBe('neighbor');
    expect(out.tree).toEqual(tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5])));
  });

  it('restores exact beside a split sibling after the removed parent collapsed', () => {
    const original = tree(mk('row', [leaf('a'), 0.4], [mk('col', [leaf('b'), 0.5], [leaf('c'), 0.5]), 0.6]));
    const removed = remove(original, 'a');

    const out = restore(removed.tree, removed.token!);

    expect(out.tier).toBe('exact');
    expect(validate(out.tree)).toEqual([]);
    expect(out.tree).toEqual(original);
    expect(rects(out.tree, big)).toEqual(rects(original, big));
  });

  it('restores exact through a fingerprinted ancestor when the sibling leaf is nested', () => {
    const original = tree(mk('row', [leaf('a'), 0.25], [mk('col', [leaf('b'), 0.5], [leaf('c'), 0.5]), 0.5], [leaf('d'), 0.25]));
    const removed = remove(original, 'a');

    const out = restore(removed.tree, removed.token!);

    expect(out.tier).toBe('exact');
    expect(validate(out.tree)).toEqual([]);
    expect(out.tree).toEqual(original);
    expect(rects(out.tree, big)).toEqual(rects(original, big));
  });

  it('degrades to fallback via a reference leaf when the sibling is gone', () => {
    const original = tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5]));
    const removed = remove(original, 'a'); // token.siblingId === 'b'
    // Now remove b as well, via a detour that keeps a live leaf 'c'.
    const withC = split(removed.tree, 'b', 'right', 'c').tree; // row[b, c]
    const gone = remove(withC, 'b').tree; // leaf c — sibling 'b' no longer exists
    const out = restore(gone, removed.token!, { fallbackRef: 'c', rect: R(0, 0, 100, 60), layoutOpts: opts });
    expect(out.tier).toBe('fallback');
    expect(validate(out.tree)).toEqual([]);
    expect(leaves(out.tree).sort()).toEqual(['a', 'c']);
  });

  it('fails when no tier applies and no reference is given', () => {
    const original = tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5]));
    const removed = remove(original, 'a');
    const withC = split(removed.tree, 'b', 'right', 'c').tree;
    const gone = remove(withC, 'b').tree; // leaf c
    const out = restore(gone, removed.token!);
    expect(out).toMatchObject({ ok: false, tier: null });
    expect(out.tree).toBe(gone);
  });

  it('restores into an empty tree as the new root (fallback)', () => {
    const removed = remove(leafTree('a'), 'a');
    const out = restore(tree(null), removed.token!);
    expect(out).toMatchObject({ ok: true, tier: 'fallback' });
    expect(out.tree).toEqual(leafTree('a'));
  });

  it('refuses to restore a leaf already present', () => {
    const t = tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5]));
    const removed = remove(t, 'b');
    const reAdded = restore(removed.tree, removed.token!).tree; // b back
    const out = restore(reAdded, removed.token!);
    expect(out).toMatchObject({ ok: false, tier: null });
  });
});
