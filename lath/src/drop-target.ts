// Drag scopes are ephemeral. A range groups adjacent children for one operation;
// the committed tree still obeys the same-direction flattening invariant.
import {
  type Edge, type LathNode, type LathTree, type LeafId, type Rect,
  nodeAtPath, normalizeWeights, replaceAtPath,
} from './model';
import { type LayoutOpts, nodeRectAtPath } from './layout';

export type EdgeDropTarget = {
  kind: 'edge';
  path: number[];
  edge: Edge;
  /** Half-open child range of the split at path. At least two children. */
  range?: { start: number; end: number };
};
export type DropTarget = EdgeDropTarget | { kind: 'swap'; leaf: LeafId };

/** Materialize a virtual group WITHOUT normalizing it away before insertion.
 * The caller must normalize its final structural result before publishing it. */
export function materializeTarget(tree: LathTree, target: EdgeDropTarget): { tree: LathTree; path: number[] } | null {
  const node = nodeAtPath(tree, target.path);
  if (!node) return null;
  if (!target.range) return { tree, path: target.path };
  const { start, end } = target.range;
  if (node.kind !== 'split' || !Number.isInteger(start) || !Number.isInteger(end)
    || start < 0 || end > node.children.length || end - start < 2) return null;
  // Every child is the split itself; a one-child wrapper would size the drop as a sibling.
  if (end - start === node.children.length) return { tree, path: target.path };
  const selected = node.children.slice(start, end);
  const group: LathNode = { kind: 'split', dir: node.dir, children: normalizeWeights(selected) };
  const replacement: LathNode = {
    kind: 'split', dir: node.dir,
    children: [
      ...node.children.slice(0, start),
      { node: group, weight: selected.reduce((sum, child) => sum + child.weight, 0) },
      ...node.children.slice(end),
    ],
  };
  return { tree: { root: replaceAtPath(tree.root!, target.path, replacement) }, path: [...target.path, start] };
}

/** Find a surviving node OR adjacent sibling range by leaf identity, after removal
 * has collapsed and flattened the input tree. Never shrink a group to one leaf. */
export function targetByLeafSet(tree: LathTree, wanted: Set<LeafId>, edge: Edge): EdgeDropTarget | null {
  if (!wanted.size) return null;
  let found: EdgeDropTarget | null = null;
  const walk = (node: LathNode, path: number[]): LeafId[] => {
    const parts = node.kind === 'leaf' ? [[node.id]] : node.children.map((child, i) => walk(child.node, [...path, i]));
    const ids = parts.flat();
    if (ids.length === wanted.size && ids.every(id => wanted.has(id))) {
      found = { kind: 'edge', path, edge };
    } else if (node.kind === 'split') {
      const counts = parts.map(ids => ids.filter(id => wanted.has(id)).length);
      const first = counts.findIndex(count => count > 0);
      let last = counts.length - 1;
      while (last >= 0 && counts[last] === 0) last--;
      if (first >= 0 && last > first
        && counts.reduce((sum, count) => sum + count, 0) === wanted.size
        && counts.slice(first, last + 1).every((count, i) => count > 0 && count === parts[first + i].length)) {
        found = { kind: 'edge', path, edge, range: { start: first, end: last + 1 } };
      }
    }
    return ids;
  };
  if (tree.root) walk(tree.root, []);
  return found;
}

/** Original on-screen bounds of the scope, including the gaps between its children. */
export function targetRect(tree: LathTree, rect: Rect, opts: LayoutOpts, target: EdgeDropTarget): Rect | null {
  if (!target.range) return nodeRectAtPath(tree, rect, opts, target.path);
  if (!materializeTarget(tree, target)) return null;
  const first = nodeRectAtPath(tree, rect, opts, [...target.path, target.range.start]);
  const last = nodeRectAtPath(tree, rect, opts, [...target.path, target.range.end - 1]);
  if (!first || !last) return null;
  return { x: first.x, y: first.y, width: last.x + last.width - first.x, height: last.y + last.height - first.y };
}
