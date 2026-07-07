// Lath operations: the pure tree transforms plus their restore tokens and drop
// targets. Every op is `(tree, …) → { tree, ok, … }`, synchronous, and returns a tree
// that passes `validate`. On any invalid input the *input tree object* is returned
// unchanged with `ok: false`, so callers can identity-compare to detect no-ops.
// See docs/specs/tiling-engine.md ("Operations", "Restore tokens", "Hierarchical DnD").

import {
  type Edge,
  type LathChild,
  type LathNode,
  type LathTree,
  type LeafId,
  type Rect,
  edgeAxis,
  edgeIsBefore,
  findLeafPath,
  leaves,
  leafTree,
  nodeAtPath,
  normalize,
  normalizeWeights,
  replaceAtPath,
  structureFingerprint,
} from './model';
import { type LayoutOpts, autoEdge, minSpan, nodeRectAtPath } from './layout';

type SplitNode = Extract<LathNode, { kind: 'split' }>;

/** JSON-serializable restore context captured by `remove`, persisted with Doors. */
export type RestoreToken = {
  leafId: LeafId;
  /** Normalized weight the leaf had in its parent split. */
  weight: number;
  /** Nearest same-parent leaf sibling (adjacent index preferred: the one before, else
   *  after; a split sibling contributes its first leaf). Null when it was the root leaf. */
  siblingId: LeafId | null;
  /** Edge of `siblingId` the leaf sat on, so neighbor-tier restore is
   *  `split(siblingId, edge, leafId)`. `'right'` for a root-leaf removal. */
  edge: Edge;
  /** The leaf's child index in its parent split pre-removal. */
  index: number;
  /** Structure-only fingerprint of the parent split *with the leaf removed*; null for
   *  the root leaf. Restore's exact tier matches this against the sibling's live parent. */
  fingerprint: string | null;
};

/** A resolved drop, produced (in later stages) by hit-testing. */
export type DropTarget =
  | { kind: 'edge'; path: number[]; edge: Edge }
  | { kind: 'swap'; leaf: LeafId };

function mkLeaf(id: LeafId): LathNode {
  return { kind: 'leaf', id };
}

/** Insert `newId` beside `at`. Always builds a nested split of the edge's axis at
 *  0.5/0.5 (order per edge) in `at`'s place; `normalize` then flattens it into the
 *  parent when directions match (extending the split, both siblings ending at half
 *  `at`'s weight) or leaves it nested otherwise. `newId` must be new; `at` must exist. */
export function split(tree: LathTree, at: LeafId, edge: Edge, newId: LeafId): { tree: LathTree; ok: boolean } {
  if (tree.root === null) return { tree, ok: false };
  const atPath = findLeafPath(tree, at);
  if (atPath === null) return { tree, ok: false };
  if (findLeafPath(tree, newId) !== null) return { tree, ok: false };

  const axis = edgeAxis(edge);
  const before = edgeIsBefore(edge);
  const atLeaf = mkLeaf(at);
  const newLeaf = mkLeaf(newId);
  const nested: LathNode = {
    kind: 'split',
    dir: axis,
    children: before
      ? [{ node: newLeaf, weight: 0.5 }, { node: atLeaf, weight: 0.5 }]
      : [{ node: atLeaf, weight: 0.5 }, { node: newLeaf, weight: 0.5 }],
  };
  return { tree: { root: normalize(replaceAtPath(tree.root, atPath, nested)) }, ok: true };
}

/** Remove a leaf; surviving siblings absorb its weight proportionally, single-child
 *  splits collapse, and same-direction splits re-flatten. Removing the root leaf yields
 *  `{ root: null }`. Returns a `RestoreToken` describing where the leaf sat. */
export function remove(tree: LathTree, id: LeafId): { tree: LathTree; ok: boolean; token: RestoreToken | null } {
  const path = findLeafPath(tree, id);
  if (path === null) return { tree, ok: false, token: null };

  if (path.length === 0) {
    const token: RestoreToken = { leafId: id, weight: 1, siblingId: null, edge: 'right', index: 0, fingerprint: null };
    return { tree: { root: null }, ok: true, token };
  }

  const parentPath = path.slice(0, -1);
  const idx = path[path.length - 1];
  const parent = nodeAtPath(tree, parentPath) as SplitNode;
  const weight = parent.children[idx].weight;

  // Prefer the sibling before (leaf sat after it → right/bottom edge); else the one after.
  const before = idx > 0;
  const sibChild = parent.children[before ? idx - 1 : idx + 1].node;
  const siblingId = sibChild.kind === 'leaf' ? sibChild.id : leaves({ root: sibChild })[0];
  const edge: Edge = before
    ? parent.dir === 'row'
      ? 'right'
      : 'bottom'
    : parent.dir === 'row'
      ? 'left'
      : 'top';

  const postChildren = parent.children.filter((_, i) => i !== idx);
  const fingerprint = structureFingerprint({ kind: 'split', dir: parent.dir, children: postChildren });
  const token: RestoreToken = { leafId: id, weight, siblingId, edge, index: idx, fingerprint };

  const newParent: LathNode = { kind: 'split', dir: parent.dir, children: postChildren };
  return { tree: { root: normalize(replaceAtPath(tree.root as LathNode, parentPath, newParent)) }, ok: true, token };
}

/** Reinsert a removed leaf, best-effort, in three degrading tiers:
 *  exact (the fingerprinted parent still exists → same index + weight),
 *  neighbor (the sibling still exists → split beside it on the original edge),
 *  fallback (split beside `opts.fallbackRef` via `autoEdge`, or `'right'` without a rect).
 *  An empty tree restores the leaf as the root (`'fallback'`). A leaf already present
 *  fails with `tier: null`. */
export function restore(
  tree: LathTree,
  token: RestoreToken,
  opts?: { fallbackRef?: LeafId; rect?: Rect; layoutOpts?: LayoutOpts },
): { tree: LathTree; ok: boolean; tier: 'exact' | 'neighbor' | 'fallback' | null } {
  if (findLeafPath(tree, token.leafId) !== null) return { tree, ok: false, tier: null };

  if (tree.root === null) return { tree: leafTree(token.leafId), ok: true, tier: 'fallback' };

  // exact
  if (token.siblingId !== null && token.fingerprint !== null) {
    const sibPath = findLeafPath(tree, token.siblingId);
    if (sibPath !== null && sibPath.length > 0) {
      const parentPath = sibPath.slice(0, -1);
      const parent = nodeAtPath(tree, parentPath);
      if (parent && parent.kind === 'split' && structureFingerprint(parent) === token.fingerprint) {
        const scaled = parent.children.map((c) => ({ node: c.node, weight: c.weight * (1 - token.weight) }));
        const insertAt = Math.min(Math.max(token.index, 0), scaled.length);
        const children: LathChild[] = [
          ...scaled.slice(0, insertAt),
          { node: mkLeaf(token.leafId), weight: token.weight },
          ...scaled.slice(insertAt),
        ];
        const newParent: LathNode = { kind: 'split', dir: parent.dir, children: normalizeWeights(children) };
        return {
          tree: { root: normalize(replaceAtPath(tree.root, parentPath, newParent)) },
          ok: true,
          tier: 'exact',
        };
      }
    }
  }

  // neighbor
  if (token.siblingId !== null && findLeafPath(tree, token.siblingId) !== null) {
    const r = split(tree, token.siblingId, token.edge, token.leafId);
    if (r.ok) return { tree: r.tree, ok: true, tier: 'neighbor' };
  }

  // fallback
  if (opts?.fallbackRef && findLeafPath(tree, opts.fallbackRef) !== null) {
    const edge =
      opts.rect && opts.layoutOpts ? autoEdge(tree, opts.rect, opts.fallbackRef, opts.layoutOpts) : 'right';
    const r = split(tree, opts.fallbackRef, edge, token.leafId);
    if (r.ok) return { tree: r.tree, ok: true, tier: 'fallback' };
  }

  return { tree, ok: false, tier: null };
}

/** Atomic identity swap in place — `oldId` becomes `newId` without any transient
 *  add/remove states. `oldId` must exist; `newId` must not already exist. */
export function replace(tree: LathTree, oldId: LeafId, newId: LeafId): { tree: LathTree; ok: boolean } {
  const path = findLeafPath(tree, oldId);
  if (path === null) return { tree, ok: false };
  if (findLeafPath(tree, newId) !== null) return { tree, ok: false };
  return { tree: { root: replaceAtPath(tree.root as LathNode, path, mkLeaf(newId)) }, ok: true };
}

/** Exchange two leaf identities, leaving structure and weights untouched.
 *  `a === b` or either leaf missing → `ok: false`. */
export function swap(tree: LathTree, a: LeafId, b: LeafId): { tree: LathTree; ok: boolean } {
  if (a === b) return { tree, ok: false };
  const pa = findLeafPath(tree, a);
  const pb = findLeafPath(tree, b);
  if (pa === null || pb === null) return { tree, ok: false };
  let root = replaceAtPath(tree.root as LathNode, pa, mkLeaf(b));
  root = replaceAtPath(root, pb, mkLeaf(a));
  return { tree: { root }, ok: true };
}

/** Shallowest node whose leaf set is exactly `target`, or null. Because leaf ids are
 *  unique, at most one node matches. */
function findPathByLeafSet(tree: LathTree, target: Set<LeafId>): number[] | null {
  let result: number[] | null = null;
  const eq = (s: Set<LeafId>): boolean => s.size === target.size && [...s].every((x) => target.has(x));
  const walk = (node: LathNode, path: number[]): Set<LeafId> => {
    let set: Set<LeafId>;
    if (node.kind === 'leaf') set = new Set([node.id]);
    else {
      set = new Set();
      node.children.forEach((c, i) => {
        for (const id of walk(c.node, [...path, i])) set.add(id);
      });
    }
    if (eq(set) && (result === null || path.length < result.length)) result = path;
    return set;
  };
  if (tree.root) walk(tree.root, []);
  return result;
}

/** Insert leaf `newId` (raw weight `w`, the moved leaf's carried weight) beside the
 *  node at `targetPath`, at that node's parent level. Sibling insert when the parent
 *  runs along the edge axis (renormalized alongside current siblings); otherwise nest
 *  the target under a new split (target keeps the `1 - w` complement). `normalize`
 *  extends/flattens as directions dictate. */
function insertBesideNode(tree: LathTree, targetPath: number[], edge: Edge, newId: LeafId, w: number): LathTree {
  const axis = edgeAxis(edge);
  const before = edgeIsBefore(edge);
  const newLeaf = mkLeaf(newId);
  const root = tree.root as LathNode;

  if (targetPath.length === 0) {
    const nested: LathNode = {
      kind: 'split',
      dir: axis,
      children: before
        ? [{ node: newLeaf, weight: w }, { node: root, weight: 1 - w }]
        : [{ node: root, weight: 1 - w }, { node: newLeaf, weight: w }],
    };
    return { root: normalize(nested) };
  }

  const parentPath = targetPath.slice(0, -1);
  const idx = targetPath[targetPath.length - 1];
  const parent = nodeAtPath(tree, parentPath);
  if (parent && parent.kind === 'split' && parent.dir === axis) {
    const children = parent.children.slice();
    children.splice(before ? idx : idx + 1, 0, { node: newLeaf, weight: w });
    const newParent: LathNode = { kind: 'split', dir: axis, children: normalizeWeights(children) };
    return { root: normalize(replaceAtPath(root, parentPath, newParent)) };
  }

  const targetNode = nodeAtPath(tree, targetPath) as LathNode;
  const nested: LathNode = {
    kind: 'split',
    dir: axis,
    children: before
      ? [{ node: newLeaf, weight: w }, { node: targetNode, weight: 1 - w }]
      : [{ node: targetNode, weight: 1 - w }, { node: newLeaf, weight: w }],
  };
  return { root: normalize(replaceAtPath(root, targetPath, nested)) };
}

/** Insert a NEW leaf `id` beside the node named by an `edge` `target`, carrying
 *  `weight` into its new context (raw — renormalized alongside real siblings for a
 *  sibling insert, or `weight`/`1 - weight` when nesting). `move` passes the dragged
 *  leaf's old normalized weight; door drops omit it → the default `0.5` split. The
 *  public half of `move`: `move` = weight + `remove` + re-find path + `insert`. A
 *  `swap` target, an already-present `id`, an empty tree, or a path off the tree all
 *  reject with `ok: false`. The weight is clamped into `(0, 1)` so any caller value
 *  yields a valid tree. */
export function insert(
  tree: LathTree,
  id: LeafId,
  target: DropTarget,
  weight = 0.5,
): { tree: LathTree; ok: boolean } {
  if (target.kind === 'swap') return { tree, ok: false };
  if (tree.root === null) return { tree, ok: false };
  if (findLeafPath(tree, id) !== null) return { tree, ok: false };
  if (nodeAtPath(tree, target.path) === null) return { tree, ok: false };
  const eps = 1e-6;
  const w = Math.min(Math.max(weight, eps), 1 - eps);
  return { tree: insertBesideNode(tree, target.path, target.edge, id, w), ok: true };
}

/** Move a leaf to a drop target as one op (no token). A `swap` target defers to
 *  `swap`; an `edge` target is `remove` + `insert` beside the node at path, with the
 *  moved leaf carrying its old normalized weight. The path is read against the *input*
 *  tree, then re-found in the post-removal tree by the target's surviving leaf set. */
export function move(tree: LathTree, id: LeafId, target: DropTarget): { tree: LathTree; ok: boolean } {
  if (target.kind === 'swap') {
    const r = swap(tree, id, target.leaf);
    return { tree: r.tree, ok: r.ok };
  }

  const idPath = findLeafPath(tree, id);
  if (idPath === null) return { tree, ok: false };
  const targetNode = nodeAtPath(tree, target.path);
  if (targetNode === null) return { tree, ok: false };

  const targetLeaves = leaves({ root: targetNode });
  // The dragged leaf is the whole target subtree / its only descendant leaf — nothing to be beside.
  if (targetLeaves.length === 1 && targetLeaves[0] === id) return { tree, ok: false };

  const w = idPath.length === 0 ? 1 : (nodeAtPath(tree, idPath.slice(0, -1)) as SplitNode).children[idPath[idPath.length - 1]].weight;

  const t2 = remove(tree, id).tree;

  const targetSet = new Set(targetLeaves.filter((l) => l !== id));
  let insertPath = findPathByLeafSet(t2, targetSet);
  if (insertPath === null) {
    // Rare: the target subtree dissolved (its split flattened as the removal collapsed a
    // neighbor). Degrade to inserting beside the target's first surviving leaf.
    const anchor = targetLeaves.find((l) => l !== id);
    insertPath = anchor !== undefined ? findLeafPath(t2, anchor) : null;
    if (insertPath === null) return { tree, ok: false };
  }

  const r = insert(t2, id, { kind: 'edge', path: insertPath, edge: target.edge }, w);
  return r.ok ? r : { tree, ok: false };
}

/** Adjust the two weights adjacent to `boundary` (children `boundary` and
 *  `boundary + 1`) of the split at `splitPath` by `deltaPx`, converted through the
 *  split's laid-out available span. The delta clamps to the feasible range (neither
 *  child below its recursive `minSpan`) rather than failing; a fully-clamped no-op is
 *  still `ok: true`. Streams during a sash drag — pass the ORIGINAL tree each frame
 *  with a cumulative delta and commit the final result on pointerup. Invalid path,
 *  boundary out of range, or a zero-size span → `ok: false`. */
export function resize(
  tree: LathTree,
  splitPath: number[],
  boundary: number,
  deltaPx: number,
  rect: Rect,
  opts: LayoutOpts,
): { tree: LathTree; ok: boolean } {
  const node = nodeAtPath(tree, splitPath);
  if (!node || node.kind !== 'split') return { tree, ok: false };
  if (boundary < 0 || boundary >= node.children.length - 1) return { tree, ok: false };

  const splitRect = nodeRectAtPath(tree, rect, opts, splitPath);
  if (!splitRect) return { tree, ok: false };
  const span = node.dir === 'row' ? splitRect.width : splitRect.height;
  const available = span - opts.gap * (node.children.length - 1);
  if (available <= 0) return { tree, ok: false };

  const a = boundary;
  const b = boundary + 1;
  const wa = node.children[a].weight;
  const wb = node.children[b].weight;
  const pairSum = wa + wb;
  const minA = minSpan(node.children[a].node, node.dir, opts) / available;
  const minB = minSpan(node.children[b].node, node.dir, opts) / available;

  let newWa: number;
  const lo = minA;
  const hi = pairSum - minB;
  if (lo > hi) {
    // Neither min fits in the pair's budget — split proportionally to the mins.
    newWa = minA + minB > 0 ? pairSum * (minA / (minA + minB)) : pairSum / 2;
  } else {
    newWa = Math.min(Math.max(wa + deltaPx / available, lo), hi);
  }
  // A `minLeaf` of 0 permits a 0px child, but the tree's weight > 0 invariant does
  // not — keep both weights strictly positive (they still round to 0px in layout).
  const eps = 1e-4 * pairSum;
  newWa = Math.min(Math.max(newWa, eps), pairSum - eps);
  const newWb = pairSum - newWa;

  const children = node.children.slice();
  children[a] = { node: node.children[a].node, weight: newWa };
  children[b] = { node: node.children[b].node, weight: newWb };
  const newNode: LathNode = { kind: 'split', dir: node.dir, children };
  return { tree: { root: normalize(replaceAtPath(tree.root as LathNode, splitPath, newNode)) }, ok: true };
}
