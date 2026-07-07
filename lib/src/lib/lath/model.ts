// Lath core model: the split tree and the invariant-preserving constructors every
// op builds through. Pure data — no DOM, React, or timing. See
// docs/specs/tiling-engine.md ("Core model") for the contract this implements.

export type LeafId = string;

/** `'left'` / `'right'` split on the x axis (a `'row'` split); `'top'` / `'bottom'`
 *  on the y axis (a `'col'` split). */
export type Edge = 'left' | 'right' | 'top' | 'bottom';

export type Rect = { x: number; y: number; width: number; height: number };
export type Size = { width: number; height: number };

/** Whether two rects match within `eps` on every field (default `0` → exact). Shared
 *  by hit-test's layout comparison (exact) and the animator's frame settle check
 *  (loose, `eps` 0.01). */
export function rectsClose(a: Rect, b: Rect, eps = 0): boolean {
  return (
    Math.abs(a.x - b.x) <= eps &&
    Math.abs(a.y - b.y) <= eps &&
    Math.abs(a.width - b.width) <= eps &&
    Math.abs(a.height - b.height) <= eps
  );
}

/** Stable `"x,y,w,h"` string identity of a rect — the dedup/change key shared by
 *  hit-test's candidate de-duplication and the drag-preview change guard. */
export function rectKey(r: Rect): string {
  return `${r.x},${r.y},${r.width},${r.height}`;
}

/** A `'row'` split lays its children left→right; a `'col'` split lays them top→bottom. */
export type LathNode =
  | { kind: 'leaf'; id: LeafId }
  | { kind: 'split'; dir: 'row' | 'col'; children: LathChild[] };

export type LathChild = { node: LathNode; weight: number };

/** `root: null` is the empty Wall. Trees are immutable; ops return fresh nodes
 *  along the mutated path and share structure everywhere else. */
export type LathTree = { root: LathNode | null };

/** The split axis an edge divides. `'left'`/`'right'` → `'row'`; `'top'`/`'bottom'` → `'col'`. */
export function edgeAxis(edge: Edge): 'row' | 'col' {
  return edge === 'left' || edge === 'right' ? 'row' : 'col';
}

/** True when inserting on `edge` places the new sibling *before* the reference
 *  child in split order (`'left'`/`'top'`); false for `'right'`/`'bottom'`. */
export function edgeIsBefore(edge: Edge): boolean {
  return edge === 'left' || edge === 'top';
}

/** The opposite edge (`'left'` ↔ `'right'`, `'top'` ↔ `'bottom'`). Encodes the
 *  animation contract's "enter from the shared boundary" rule: a newly-placed leaf
 *  grows FROM the edge it shares with its reference, i.e. the one opposite where it
 *  landed (a pane split to the `'right'` enters from its `'left'` edge). */
export function oppositeEdge(edge: Edge): Edge {
  switch (edge) {
    case 'left':
      return 'right';
    case 'right':
      return 'left';
    case 'top':
      return 'bottom';
    case 'bottom':
      return 'top';
  }
}

/** The single-pane Wall — how the Wall seeds the tree; there is no op for
 *  inserting into an empty tree. */
export function leafTree(id: LeafId): LathTree {
  return { root: { kind: 'leaf', id } };
}

/** Pre-order leaf ids of the tree. */
export function leaves(tree: LathTree): LeafId[] {
  const out: LeafId[] = [];
  const walk = (node: LathNode): void => {
    if (node.kind === 'leaf') out.push(node.id);
    else for (const child of node.children) walk(child.node);
  };
  if (tree.root) walk(tree.root);
  return out;
}

/** Path (child-index chain from the root; root is `[]`) of the leaf `id`, or null
 *  if absent. Paths are ephemeral — valid only against the tree they were derived from. */
export function findLeafPath(tree: LathTree, id: LeafId): number[] | null {
  let found: number[] | null = null;
  const walk = (node: LathNode, path: number[]): void => {
    if (found) return;
    if (node.kind === 'leaf') {
      if (node.id === id) found = path;
      return;
    }
    node.children.forEach((child, i) => walk(child.node, [...path, i]));
  };
  if (tree.root) walk(tree.root, []);
  return found;
}

/** The node at `path`, or null if the path leaves the tree. */
export function nodeAtPath(tree: LathTree, path: number[]): LathNode | null {
  let node: LathNode | null = tree.root;
  for (const i of path) {
    if (!node || node.kind !== 'split') return null;
    const child = node.children[i];
    if (!child) return null;
    node = child.node;
  }
  return node;
}

/** Human-readable invariant violations; empty array = valid. Enforces: splits have
 *  ≥ 2 children; no split directly contains a same-`dir` split; weights are > 0 and
 *  sum to 1 (tolerance 1e-6) within each split; leaf ids are unique. */
export function validate(tree: LathTree): string[] {
  const errors: string[] = [];
  const seen = new Set<LeafId>();
  const walk = (node: LathNode, path: number[]): void => {
    const at = `[${path.join(',')}]`;
    if (node.kind === 'leaf') {
      if (seen.has(node.id)) errors.push(`duplicate leaf id "${node.id}" at path ${at}`);
      seen.add(node.id);
      return;
    }
    if (node.children.length < 2) {
      errors.push(`split at ${at} has ${node.children.length} children (< 2)`);
    }
    let sum = 0;
    node.children.forEach((child, i) => {
      if (!(child.weight > 0)) {
        errors.push(`child ${i} of split at ${at} has non-positive weight ${child.weight}`);
      }
      sum += child.weight;
      if (child.node.kind === 'split' && child.node.dir === node.dir) {
        errors.push(`split at ${at} directly contains a same-direction (${node.dir}) split at child ${i}`);
      }
      walk(child.node, [...path, i]);
    });
    if (node.children.length > 0 && Math.abs(sum - 1) > 1e-6) {
      errors.push(`weights of split at ${at} sum to ${sum} (≠ 1)`);
    }
  };
  if (tree.root) walk(tree.root, []);
  return errors;
}

/** Rescale a child list so its weights sum to 1, preserving proportions. Falls
 *  back to equal weights if the incoming sum is non-positive. */
export function normalizeWeights(children: LathChild[]): LathChild[] {
  const sum = children.reduce((s, c) => s + c.weight, 0);
  if (sum <= 0) {
    const w = children.length > 0 ? 1 / children.length : 0;
    return children.map((c) => ({ node: c.node, weight: w }));
  }
  return children.map((c) => ({ node: c.node, weight: c.weight / sum }));
}

/** Canonicalize a node so all invariants hold by construction: recursively flatten
 *  same-direction child splits into the parent (scaling their children by the
 *  child's weight), collapse single-child splits, drop empty splits, and renormalize
 *  each split's weights. Returns null when the subtree normalizes to nothing. */
export function normalize(node: LathNode): LathNode | null {
  if (node.kind === 'leaf') return node;
  const collected: LathChild[] = [];
  for (const child of node.children) {
    const n = normalize(child.node);
    if (n === null) continue;
    if (n.kind === 'split' && n.dir === node.dir) {
      for (const gc of n.children) collected.push({ node: gc.node, weight: gc.weight * child.weight });
    } else {
      collected.push({ node: n, weight: child.weight });
    }
  }
  if (collected.length === 0) return null;
  if (collected.length === 1) return collected[0].node;
  return { kind: 'split', dir: node.dir, children: normalizeWeights(collected) };
}

/** Replace the subtree at `path` (root is `[]`) with `replacement`, sharing structure
 *  outside the rewritten spine. Callers pass valid paths; a path that leaves the tree
 *  returns `replacement` unchanged from wherever the walk stopped. */
export function replaceAtPath(root: LathNode, path: number[], replacement: LathNode): LathNode {
  if (path.length === 0) return replacement;
  if (root.kind !== 'split') return root;
  const [i, ...rest] = path;
  const child = root.children[i];
  if (!child) return root;
  const children = root.children.slice();
  children[i] = { node: replaceAtPath(child.node, rest, replacement), weight: child.weight };
  return { kind: 'split', dir: root.dir, children };
}

/** Structure-only fingerprint (kinds, dirs, leaf ids — weights stripped) used by
 *  restore's exact tier to recognize an unchanged surrounding split. Because leaf
 *  ids are globally unique, a match identifies exactly one subtree. */
export function structureFingerprint(node: LathNode): string {
  const strip = (n: LathNode): unknown =>
    n.kind === 'leaf'
      ? { k: 'leaf', id: n.id }
      : { k: 'split', dir: n.dir, children: n.children.map((c) => strip(c.node)) };
  return JSON.stringify(strip(node));
}
