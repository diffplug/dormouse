import { describe, it, expect, vi } from 'vitest';
import { createLathWallStore, type LathWallStore, LATH_LAYOUT_OPTS } from './lath-wall-store';
import { leaves, oppositeEdge, type LathNode, type LathTree } from '../../lib/lath/model';
import { leaf, split, tree } from '../../lib/lath/test-util';
import { leafMeta } from './lath-test-fixtures';

const RECT = { x: 0, y: 0, width: 800, height: 600 };

/** a | b, a row split at 50/50 (built from the shared core test builders). */
const twoLeafRow = (): LathTree =>
  tree(split('row', [leaf('a'), 0.5] as [LathNode, number], [leaf('b'), 0.5] as [LathNode, number]));

function seeded(): LathWallStore {
  const store = createLathWallStore();
  store.seed(twoLeafRow(), [
    ['a', leafMeta({ title: 'A' })],
    ['b', leafMeta({ component: 'browser', title: 'B' })],
  ]);
  return store;
}

describe('createLathWallStore — snapshot basics', () => {
  it('starts empty and returns a stable snapshot identity between commits', () => {
    const store = createLathWallStore();
    const s0 = store.getSnapshot();
    expect(s0.tree.root).toBeNull();
    expect(s0.leafMeta.size).toBe(0);
    expect(s0.zoomedId).toBeNull();
    expect(s0.revision).toBe(0);
    expect(store.getSnapshot()).toBe(s0); // same identity, no commit

    store.seed(twoLeafRow(), [['a', leafMeta()], ['b', leafMeta()]]);
    expect(store.getSnapshot()).not.toBe(s0);
    expect(store.getSnapshot().revision).toBe(1);
  });

  it('seed replaces everything and clears zoom', () => {
    const store = seeded();
    store.setZoomed('a');
    store.seed({ root: { kind: 'leaf', id: 'z' } }, [['z', leafMeta()]]);
    const s = store.getSnapshot();
    expect(leaves(s.tree)).toEqual(['z']);
    expect(s.zoomedId).toBeNull();
    expect([...s.leafMeta.keys()]).toEqual(['z']);
  });
});

describe('addLeaf', () => {
  it('seeds the root of an empty tree', () => {
    const store = createLathWallStore();
    const r = store.addLeaf('x', leafMeta(), null);
    expect(r.ok).toBe(true);
    expect(leaves(store.getSnapshot().tree)).toEqual(['x']);
    expect(store.getSnapshot().leafMeta.get('x')?.title).toBe('t');
  });

  it('splits beside a ref leaf on the given edge', () => {
    const store = seeded();
    const r = store.addLeaf('c', leafMeta(), { refId: 'a', edge: 'right' });
    expect(r.ok).toBe(true);
    expect(new Set(leaves(store.getSnapshot().tree))).toEqual(new Set(['a', 'b', 'c']));
    expect(store.has('c')).toBe(true);
  });

  it('falls back to splitting beside the last leaf via autoEdge when position is null', () => {
    const store = seeded();
    store.setLayoutGeometry(RECT, LATH_LAYOUT_OPTS);
    const r = store.addLeaf('c', leafMeta(), null);
    expect(r.ok).toBe(true);
    // last leaf is 'b'; wide row rect → autoEdge picks a right split beside it.
    expect(store.has('c')).toBe(true);
  });

  it('rejects a duplicate id without committing or notifying', () => {
    const store = seeded();
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getSnapshot();
    const r = store.addLeaf('a', leafMeta(), { refId: 'b', edge: 'right' });
    expect(r.ok).toBe(false);
    expect(store.getSnapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('removeLeaf', () => {
  it('removes a leaf, deletes its meta, and returns a token', () => {
    const store = seeded();
    const r = store.removeLeaf('b');
    expect(r.ok).toBe(true);
    expect(r.token).not.toBeNull();
    expect(r.token?.leafId).toBe('b');
    expect(leaves(store.getSnapshot().tree)).toEqual(['a']);
    expect(store.getSnapshot().leafMeta.has('b')).toBe(false);
    expect(store.getSnapshot().leafMeta.has('a')).toBe(true);
  });

  it('rejects an absent id', () => {
    const store = seeded();
    const before = store.getSnapshot();
    const r = store.removeLeaf('nope');
    expect(r).toEqual({ ok: false, token: null });
    expect(store.getSnapshot()).toBe(before);
  });

  it('clears zoomedId when the removed leaf was zoomed, but leaves it otherwise', () => {
    const store = seeded();
    store.setZoomed('a');
    // Removing a different leaf leaves the zoom intact.
    store.removeLeaf('b');
    expect(store.getSnapshot().zoomedId).toBe('a');
    // Removing the zoomed leaf clears it (invariant: zoomedId names a live leaf).
    store.removeLeaf('a');
    expect(store.getSnapshot().zoomedId).toBeNull();
  });
});

describe('replaceLeaf', () => {
  it('atomically swaps id and moves meta in one commit', () => {
    const store = seeded();
    const rev = store.getSnapshot().revision;
    const r = store.replaceLeaf('a', 'a2', leafMeta({ title: 'A2' }));
    expect(r.ok).toBe(true);
    const s = store.getSnapshot();
    expect(s.revision).toBe(rev + 1); // single commit — atomic
    expect(new Set(leaves(s.tree))).toEqual(new Set(['a2', 'b']));
    expect(s.leafMeta.has('a')).toBe(false);
    expect(s.leafMeta.get('a2')?.title).toBe('A2');
  });

  it('rejects when old is missing or new already exists', () => {
    const store = seeded();
    expect(store.replaceLeaf('nope', 'x', leafMeta()).ok).toBe(false);
    expect(store.replaceLeaf('a', 'b', leafMeta()).ok).toBe(false);
  });

  it('retargets zoomedId to the new id when the replaced leaf was zoomed', () => {
    const store = seeded();
    store.setZoomed('a');
    // Replacing a different leaf leaves the zoom on 'a'.
    store.replaceLeaf('b', 'b2', leafMeta());
    expect(store.getSnapshot().zoomedId).toBe('a');
    // Replacing the zoomed leaf follows it to the new slot id.
    store.replaceLeaf('a', 'a2', leafMeta());
    expect(store.getSnapshot().zoomedId).toBe('a2');
  });
});

describe('restoreLeaf', () => {
  it('restores a removed leaf (neighbor tier) and sets its meta', () => {
    const store = seeded();
    store.setLayoutGeometry(RECT, LATH_LAYOUT_OPTS);
    const removed = store.removeLeaf('b');
    expect(removed.ok).toBe(true);
    const r = store.restoreLeaf(leafMeta({ component: 'browser', title: 'B-back' }), removed.token!, { fallbackRef: 'a' });
    expect(r.ok).toBe(true);
    expect(r.tier).toBe('neighbor');
    expect(store.has('b')).toBe(true);
    expect(store.getSnapshot().leafMeta.get('b')?.title).toBe('B-back');
  });

  it('rejects restoring a leaf that is already present', () => {
    const store = seeded();
    const removed = store.removeLeaf('b');
    // restore once (ok), then a second restore of the same token must reject.
    store.restoreLeaf(leafMeta(), removed.token!, { fallbackRef: 'a' });
    const again = store.restoreLeaf(leafMeta(), removed.token!, { fallbackRef: 'a' });
    expect(again.ok).toBe(false);
    expect(again.tier).toBeNull();
  });
});

describe('swapLeaves', () => {
  it('exchanges positions but keeps meta keyed by id', () => {
    const store = seeded();
    const metaA = store.getSnapshot().leafMeta.get('a');
    const metaB = store.getSnapshot().leafMeta.get('b');
    const r = store.swapLeaves('a', 'b');
    expect(r.ok).toBe(true);
    const s = store.getSnapshot();
    // Positions swapped: the first child is now 'b'.
    expect(leaves(s.tree)).toEqual(['b', 'a']);
    // Meta unchanged — titles/params follow the id, no companion swap needed.
    expect(s.leafMeta.get('a')).toBe(metaA);
    expect(s.leafMeta.get('b')).toBe(metaB);
  });

  it('rejects a === b and missing leaves', () => {
    const store = seeded();
    expect(store.swapLeaves('a', 'a').ok).toBe(false);
    expect(store.swapLeaves('a', 'nope').ok).toBe(false);
  });
});

describe('moveLeaf', () => {
  it('moves a leaf onto an edge target in one commit, meta following the id', () => {
    const store = seeded();
    const metaA = store.getSnapshot().leafMeta.get('a');
    const rev = store.getSnapshot().revision;
    // Move 'a' to b's right edge → order becomes b, a.
    const r = store.moveLeaf('a', { kind: 'edge', path: [1], edge: 'right' });
    expect(r.ok).toBe(true);
    const s = store.getSnapshot();
    expect(leaves(s.tree)).toEqual(['b', 'a']);
    expect(s.revision).toBe(rev + 1); // exactly one commit
    expect(s.leafMeta.get('a')).toBe(metaA); // meta keyed by id, untouched
  });

  it('commits a center-drop swap target', () => {
    const store = seeded();
    const r = store.moveLeaf('a', { kind: 'swap', leaf: 'b' });
    expect(r.ok).toBe(true);
    expect(leaves(store.getSnapshot().tree)).toEqual(['b', 'a']);
  });

  it('rejects an invalid move without committing', () => {
    const store = seeded();
    const rev = store.getSnapshot().revision;
    expect(store.moveLeaf('nope', { kind: 'edge', path: [1], edge: 'right' }).ok).toBe(false);
    expect(store.getSnapshot().revision).toBe(rev);
  });
});

describe('insertLeaf', () => {
  it('inserts a NEW leaf onto an edge target and sets its meta', () => {
    const store = seeded();
    const r = store.insertLeaf('c', leafMeta({ title: 'C' }), { kind: 'edge', path: [1], edge: 'right' });
    expect(r.ok).toBe(true);
    const s = store.getSnapshot();
    expect(leaves(s.tree).sort()).toEqual(['a', 'b', 'c']);
    expect(s.leafMeta.get('c')).toMatchObject({ title: 'C', component: 'terminal' });
  });

  it('rejects a duplicate id or a swap target without committing', () => {
    const store = seeded();
    const rev = store.getSnapshot().revision;
    expect(store.insertLeaf('a', leafMeta(), { kind: 'edge', path: [1], edge: 'right' }).ok).toBe(false);
    expect(store.insertLeaf('c', leafMeta(), { kind: 'swap', leaf: 'a' }).ok).toBe(false);
    expect(store.getSnapshot().revision).toBe(rev);
  });
});

describe('enter hints (derived inside the mutators)', () => {
  it('addLeaf derives the opposite-edge hint from a positioned split', () => {
    const store = seeded();
    store.addLeaf('c', leafMeta(), { refId: 'a', edge: 'right' });
    // Placed on the right → grows from the shared (left) boundary.
    expect(store.consumeEnterHints().get('c')).toBe('left');
  });

  it('addLeaf derives a hint from its null-position autoEdge fallback', () => {
    const store = seeded();
    store.setLayoutGeometry(RECT, LATH_LAYOUT_OPTS);
    const edge = store.autoEdgeFor('b'); // the last leaf it splits beside
    store.addLeaf('c', leafMeta(), null);
    expect(store.consumeEnterHints().get('c')).toBe(oppositeEdge(edge));
  });

  it('restoreLeaf derives the hint from the token edge, and consume drains the map', () => {
    const store = seeded();
    store.setLayoutGeometry(RECT, LATH_LAYOUT_OPTS);
    const removed = store.removeLeaf('b');
    store.restoreLeaf(leafMeta(), removed.token!, { fallbackRef: 'a' });
    expect(store.consumeEnterHints().get('b')).toBe(oppositeEdge(removed.token!.edge));
    expect(store.consumeEnterHints().size).toBe(0); // consume clears the map
  });

  it('insertLeaf derives the hint from an edge target', () => {
    const store = seeded();
    store.insertLeaf('c', leafMeta(), { kind: 'edge', path: [1], edge: 'right' });
    expect(store.consumeEnterHints().get('c')).toBe('left');
  });

  it('an explicit pre-set setEnterHint wins over the mutator-derived hint', () => {
    const store = seeded();
    store.setEnterHint('c', 'top-left'); // policy override (e.g. auto-spawn refill)
    store.addLeaf('c', leafMeta(), { refId: 'a', edge: 'right' });
    expect(store.consumeEnterHints().get('c')).toBe('top-left');
  });

  it('sets no hint for an empty-tree root add (no edge to derive from)', () => {
    const store = createLathWallStore();
    store.addLeaf('x', leafMeta(), null); // becomes the root
    expect(store.consumeEnterHints().size).toBe(0);
  });
});

describe('resizeBoundary', () => {
  it('adjusts weights using the reported geometry', () => {
    const store = seeded();
    store.setLayoutGeometry(RECT, LATH_LAYOUT_OPTS);
    const r = store.resizeBoundary([], 0, 100);
    expect(r.ok).toBe(true);
    const root = store.getSnapshot().tree.root;
    expect(root?.kind).toBe('split');
    if (root?.kind === 'split') {
      // 'a' grew (+100px of the ~794px available → ~0.5 + 100/794).
      expect(root.children[0].weight).toBeGreaterThan(0.5);
    }
  });

  it('rejects when no geometry has been reported', () => {
    const store = seeded();
    const r = store.resizeBoundary([], 0, 100);
    expect(r.ok).toBe(false);
  });
});

describe('meta writes', () => {
  it('setTitle updates one leaf and preserves prior-snapshot immutability', () => {
    const store = seeded();
    const before = store.getSnapshot();
    store.setTitle('a', 'renamed');
    const after = store.getSnapshot();
    expect(after.leafMeta.get('a')?.title).toBe('renamed');
    expect(after.revision).toBe(before.revision + 1);
    // Old snapshot untouched (fresh Map on meta changes).
    expect(before.leafMeta.get('a')?.title).toBe('A');
    expect(after.leafMeta).not.toBe(before.leafMeta);
  });

  it('setTitle is a no-op when unchanged or absent', () => {
    const store = seeded();
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getSnapshot();
    store.setTitle('a', 'A'); // same value
    store.setTitle('missing', 'x'); // absent id
    expect(store.getSnapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });

  it('updateParams merges a patch into params', () => {
    const store = seeded();
    store.updateParams('b', { url: 'https://example.com' });
    store.updateParams('b', { key: 'k' });
    expect(store.getSnapshot().leafMeta.get('b')?.params).toEqual({ url: 'https://example.com', key: 'k' });
    // Absent id is a no-op.
    const before = store.getSnapshot();
    store.updateParams('missing', { x: 1 });
    expect(store.getSnapshot()).toBe(before);
  });
});

describe('setZoomed', () => {
  it('sets and clears the zoom target, ignoring redundant sets', () => {
    const store = seeded();
    store.setZoomed('a');
    expect(store.getSnapshot().zoomedId).toBe('a');
    const mid = store.getSnapshot();
    store.setZoomed('a'); // redundant — no commit
    expect(store.getSnapshot()).toBe(mid);
    store.setZoomed(null);
    expect(store.getSnapshot().zoomedId).toBeNull();
  });
});

describe('subscribe / notify', () => {
  it('notifies on commit and not on rejection, and unsubscribes cleanly', () => {
    const store = seeded();
    const listener = vi.fn();
    const unsub = store.subscribe(listener);
    store.setTitle('a', 'x');
    expect(listener).toHaveBeenCalledTimes(1);
    store.removeLeaf('nope'); // rejected → no notify
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    store.setTitle('a', 'y');
    expect(listener).toHaveBeenCalledTimes(1); // no longer subscribed
  });
});

describe('queries', () => {
  it('leafIds and has reflect the tree', () => {
    const store = seeded();
    expect(store.leafIds()).toEqual(['a', 'b']);
    expect(store.has('a')).toBe(true);
    expect(store.has('nope')).toBe(false);
  });

  it('neighborOf uses the seeded geometry (null without it)', () => {
    const store = seeded();
    expect(store.neighborOf('a', 'right')).toBeNull(); // no geometry yet
    store.setLayoutGeometry(RECT, LATH_LAYOUT_OPTS);
    expect(store.neighborOf('a', 'right')).toBe('b');
    expect(store.neighborOf('b', 'left')).toBe('a');
    expect(store.neighborOf('a', 'left')).toBeNull();
  });
});
