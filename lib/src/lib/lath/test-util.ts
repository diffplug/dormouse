// Shared terse constructors for the Lath core unit tests (model / ops / layout /
// property). These are test-only builders — NOT the invariant-preserving model
// constructors — so they live beside the tests, not in the shipped model.

import type { LathNode, LathTree } from './model';

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
