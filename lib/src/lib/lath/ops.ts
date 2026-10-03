// Lath operations: the pure tree transforms plus their restore tokens and drop
// targets. Every op is `(tree, …) → { tree, ok, … }`, synchronous, and returns a tree
// that passes `validate`. On any invalid input the *input tree object* is returned
// unchanged with `ok: false`, so callers can identity-compare to detect no-ops.
// See docs/specs/tiling-engine.md ("Operations", "Restore tokens", "Hierarchical
// drag and drop").

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
import { type LayoutOpts, allocateChildSpans, autoEdge, minSpan, nodeRectAtPath } from './layout';

import { type DropTarget, materializeTarget, targetByLeafSet } from './drop-target';
export type { DropTarget } from './drop-target';

type SplitNode = Extract<LathNode, { kind: 'split' }>;

/** JSON-serializable restore context captured by `remove`, persisted with Doors. */
export type RestoreToken = {
  leafId: LeafId;
  /** Normalized weight the leaf had in its parent split. */
  weight: number;
  /** Nearest same-parent leaf sibling (adjacent index preferred: the one before, else
   *  after; a split sibling contributes its first leaf). Null when it was the root leaf. */
  siblingId: LeafId | null;
  /** Leaf set of the same-parent sibling node that supplied `siblingId`.
   *  Present on tokens written after the split-subtree restore fix; absent legacy
   *  tokens degrade to the older leaf-neighbor behavior. */
  siblingLeafIds?: LeafId[];
  /** Structure-only fingerprint of that same-parent sibling node, used when the
   *  removed parent collapsed and the sibling subtree itself becomes the exact target. */
  siblingFingerprint?: string;
  /** Edge of `siblingId` the leaf sat on, so neighbor-tier restore is
   *  `split(siblingId, edge, leafId)`. `'right'` for a root-leaf removal. */
  edge: Edge;
  /** The leaf's child index in its parent split pre-removal. */
  index: number;
  /** Structure-only fingerprint of the parent split *with the leaf removed*; null for
   *  the root leaf. Restore's exact tier matches this against the sibling's live parent. */
  fingerprint: string | null;
};

function mkLeaf(id: LeafId): LathNode {
  return { kind: 'leaf', id };
}

function findSplitPathByFingerprint(tree: LathTree, fingerprint: string): number[] | null {
  let result: number[] | null = null;
  const walk = (node: LathNode, path: number[]): void => {
    if (result !== null || node.kind !== 'split') return;
    if (structureFingerprint(node) === fingerprint) {
      result = path;
      return;
    }
    node.children.forEach((child, i) => walk(child.node, [...path, i]));
  };
  if (tree.root) walk(tree.root, []);
  return result;
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
  const siblingLeafIds = leaves({ root: sibChild });
  const siblingFingerprint = structureFingerprint(sibChild);
  const edge: Edge = before
    ? parent.dir === 'row'
      ? 'right'
      : 'bottom'
    : parent.dir === 'row'
      ? 'left'
      : 'top';

  const postChildren = parent.children.filter((_, i) => i !== idx);
  const fingerprint = structureFingerprint({ kind: 'split', dir: parent.dir, children: postChildren });
  const token: RestoreToken = {
    leafId: id,
    weight,
    siblingId,
    siblingLeafIds,
    siblingFingerprint,
    edge,
    index: idx,
    fingerprint,
  };

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
    const parentPath = findSplitPathByFingerprint(tree, token.fingerprint);
    if (parentPath !== null) {
      const parent = nodeAtPath(tree, parentPath) as SplitNode;
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

    if (token.siblingLeafIds && token.siblingLeafIds.length > 1 && token.siblingFingerprint) {
      const siblingTarget = targetByLeafSet(tree, new Set(token.siblingLeafIds), token.edge);
      const resolved = siblingTarget && materializeTarget(tree, siblingTarget);
      if (resolved) {
        const sibling = nodeAtPath(resolved.tree, resolved.path);
        if (sibling && structureFingerprint(sibling) === token.siblingFingerprint) {
          const r = insert(tree, token.leafId, siblingTarget, token.weight);
          if (r.ok) return { tree: r.tree, ok: true, tier: 'exact' };
        }
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

/** Insert leaf `newId` (weight `w`) beside the node at `targetPath`, at that node's
 *  parent level. Sibling insert when the parent runs along the edge axis: renormalized
 *  alongside the current siblings, or with `keepSiblings` the siblings share the
 *  remaining `1 - w` (a reorder within the leaf's own split). Otherwise nest the target
 *  under a new split (target keeps the `1 - w` complement). `normalize` extends/flattens
 *  as directions dictate. */
function insertBesideNode(
  tree: LathTree, targetPath: number[], edge: Edge, newId: LeafId, w: number, keepSiblings = false,
): LathTree {
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
    const scale = keepSiblings ? 1 - w : 1;
    const children = parent.children.map((child) => ({ node: child.node, weight: child.weight * scale }));
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
 *  except NaN yields a valid tree; NaN is rejected. */
export function insert(
  tree: LathTree,
  id: LeafId,
  target: DropTarget,
  weight = 0.5,
): { tree: LathTree; ok: boolean } {
  return insertImpl(tree, id, target, weight, false);
}

function insertImpl(
  tree: LathTree, id: LeafId, target: DropTarget, weight: number, keepSiblings: boolean,
): { tree: LathTree; ok: boolean } {
  if (target.kind === 'swap' || Number.isNaN(weight)) return { tree, ok: false };
  if (tree.root === null) return { tree, ok: false };
  if (findLeafPath(tree, id) !== null) return { tree, ok: false };
  const resolved = materializeTarget(tree, target);
  if (!resolved) return { tree, ok: false };
  const eps = 1e-6;
  const w = Math.min(Math.max(weight, eps), 1 - eps);
  return { tree: insertBesideNode(resolved.tree, resolved.path, target.edge, id, w, keepSiblings), ok: true };
}

function sameLeafSet(a: LeafId[], b: LeafId[]): boolean {
  const set = new Set(b);
  return a.length === set.size && a.every((l) => set.has(l));
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
  const resolved = materializeTarget(tree, target);
  if (!resolved) return { tree, ok: false };
  const targetNode = nodeAtPath(resolved.tree, resolved.path)!;

  const targetLeaves = leaves({ root: targetNode });
  // The dragged leaf is the whole target subtree / its only descendant leaf — nothing to be beside.
  if (targetLeaves.length === 1 && targetLeaves[0] === id) return { tree, ok: false };

  const parent = idPath.length === 0 ? null : (nodeAtPath(tree, idPath.slice(0, -1)) as SplitNode);
  const w = parent ? parent.children[idPath[idPath.length - 1]].weight : 1;

  const t2 = remove(tree, id).tree;

  const targetSet = new Set(targetLeaves.filter((l) => l !== id));
  const destination = targetByLeafSet(t2, targetSet, target.edge);
  if (!destination) return { tree, ok: false };
  // Back into its own split: the siblings keep their proportions, so a reorder or a drop
  // at the leaf's existing boundary changes no other pane. Elsewhere it shares as an insert.
  const at = materializeTarget(t2, destination);
  const container = at && at.path.length > 0 ? nodeAtPath(at.tree, at.path.slice(0, -1)) : null;
  const ownSplit = parent !== null && container?.kind === 'split' && container.dir === parent.dir
    && sameLeafSet(leaves({ root: container }), leaves({ root: parent }).filter((l) => l !== id));
  const r = insertImpl(t2, id, destination, w, ownSplit);
  return r.ok ? r : { tree, ok: false };
}

/** Move the visible sash adjacent to `boundary` (children `boundary` and
 *  `boundary + 1`) at `splitPath` by `deltaPx`, rebasing the split on its rendered
 *  child spans so minimum clamping cannot redistribute the motion. The delta clamps to the feasible range (neither
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
  if (!Number.isInteger(boundary) || boundary < 0 || boundary >= node.children.length - 1 || !Number.isFinite(deltaPx)) {
    return { tree, ok: false };
  }

  const splitRect = nodeRectAtPath(tree, rect, opts, splitPath);
  if (!splitRect) return { tree, ok: false };
  const span = node.dir === 'row' ? splitRect.width : splitRect.height;
  const available = span - opts.gap * (node.children.length - 1);
  if (available <= 0) return { tree, ok: false };

  // Resize the boundary the user can SEE. Stored weights may differ from the
  // waterfilled, pixel-rounded allocation; applying a delta to them causes dead
  // travel at a minimum and makes unrelated boundaries jump.
  const spans = allocateChildSpans(node.children, span, opts, node.dir);
  const a = boundary;
  const b = boundary + 1;
  const pairSpan = spans[a] + spans[b];
  const minA = minSpan(node.children[a].node, node.dir, opts);
  const minB = minSpan(node.children[b].node, node.dir, opts);
  const lo = minA;
  const hi = pairSpan - minB;
  // In an overconstrained pair the layout already owns the min-proportional
  // allocation. A clamped/no-motion gesture must not change its stored proportions.
  const nextA = lo <= hi ? Math.min(Math.max(spans[a] + deltaPx, lo), hi) : spans[a];
  if (nextA === spans[a]) return { tree: { root: tree.root }, ok: true };
  spans[a] = nextA;
  spans[b] = pairSpan - nextA;
  // Rebase this split on its visible allocation so waterfill cannot redistribute
  // the drag into a third child. A zero-pixel pane retains a positive weight.
  const children = normalizeWeights(node.children.map((child, i) => ({
    node: child.node,
    weight: Math.max(spans[i], 1e-6),
  })));
  const newNode: LathNode = { kind: 'split', dir: node.dir, children };
  return { tree: { root: normalize(replaceAtPath(tree.root as LathNode, splitPath, newNode)) }, ok: true };
}
