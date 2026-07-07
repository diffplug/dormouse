// Shared terse constructors for the Lath core unit tests (model / ops / layout /
// property). These are test-only builders — NOT the invariant-preserving model
// constructors — so they live beside the tests, not in the shipped model.

import type { LathNode, LathTree, Rect } from './model';
import { type LayoutOpts, layout } from './layout';
import { type DropTarget, insert, move } from './ops';

/** A leaf node. */
export const leaf = (id: string): LathNode => ({ kind: 'leaf', id });

/** A split node from `[node, weight]` child pairs. */
export const split = (dir: 'row' | 'col', ...children: Array<[LathNode, number]>): LathNode => ({
  kind: 'split',
  dir,
  children: children.map(([node, weight]) => ({ node, weight })),
});

/** Wrap a root node (or null) as a tree. */
export const tree = (root: LathNode | null): LathTree => ({ root });

/** A rect literal. */
export const R = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

/** Expected preview rect of an internal drag: the dragged leaf's rect after `move`. */
export function movePreview(t: LathTree, dragged: string, target: DropTarget, rect: Rect, opts: LayoutOpts): Rect {
  return layout(move(t, dragged, target).tree, rect, opts).get(dragged)!;
}

/** Expected preview rect of an external drag: the inserted leaf's rect after `insert`. */
export function insertPreview(t: LathTree, id: string, target: DropTarget, rect: Rect, opts: LayoutOpts): Rect {
  return layout(insert(t, id, target).tree, rect, opts).get(id)!;
}
