// Lath layout: pure geometry over the split tree. Turns a tree + a rect into per-leaf
// rects (exact integer tiling), plus the derived queries that replace today's DOM
// rect scanning. No DOM, React, or timing. See docs/specs/tiling-engine.md ("Layout").

import type { LathNode, LathTree, LeafId, Rect, Size, Edge } from './model';

export type LayoutOpts = { gap: number; minLeaf: Size };
export type Direction = 'left' | 'right' | 'up' | 'down';

/** Minimum extent of a node along `axis` (px), honoring `minLeaf` and gaps.
 *  A split *along* `axis` sums its children plus gaps; a split *across* `axis`
 *  takes the max. Shared with resize clamping in ops.ts. */
export function minSpan(node: LathNode, axis: 'row' | 'col', opts: LayoutOpts): number {
  if (node.kind === 'leaf') return axis === 'row' ? opts.minLeaf.width : opts.minLeaf.height;
  if (node.dir === axis) {
    let sum = 0;
    for (const child of node.children) sum += minSpan(child.node, axis, opts);
    return sum + opts.gap * (node.children.length - 1);
  }
  let max = 0;
  for (const child of node.children) max = Math.max(max, minSpan(child.node, axis, opts));
  return max;
}

/** Integer child extents along a split's axis that, with `n-1` gaps, exactly tile
 *  `span`. Weights allocate `available = span - gap*(n-1)` via a min-size waterfill
 *  (stored weights are never rewritten); the fractional result is cumulative-rounded
 *  so children + gaps sum to `span` with the remainder distributed left-to-right.
 *  Overconstrained splits (mins exceed `available`) fall back to min-proportional. */
export function allocateChildSpans(
  children: readonly { node: LathNode; weight: number }[],
  span: number,
  opts: LayoutOpts,
  dir: 'row' | 'col',
): number[] {
  const n = children.length;
  const available = Math.max(0, span - opts.gap * (n - 1));
  const mins = children.map((c) => minSpan(c.node, dir, opts));
  const totalMin = mins.reduce((s, m) => s + m, 0);

  let frac: number[];
  if (totalMin > available) {
    // Overconstrained: mins can't fit, so honor them proportionally (still exact, no overlap).
    frac = totalMin > 0 ? mins.map((m) => (m / totalMin) * available) : mins.map(() => available / n);
  } else {
    // Waterfill: clamp any child below its min, redistribute the rest by weight, repeat.
    const clamped = new Array<boolean>(n).fill(false);
    frac = new Array<number>(n).fill(0);
    let remaining = available;
    for (;;) {
      let activeWeight = 0;
      let activeCount = 0;
      for (let i = 0; i < n; i++) {
        if (!clamped[i]) {
          activeWeight += children[i].weight;
          activeCount++;
        }
      }
      if (activeCount === 0) break;
      const share = (i: number): number =>
        activeWeight > 0 ? (children[i].weight / activeWeight) * remaining : remaining / activeCount;
      let clampedAny = false;
      for (let i = 0; i < n; i++) {
        if (!clamped[i] && share(i) < mins[i] - 1e-9) {
          clamped[i] = true;
          frac[i] = mins[i];
          remaining -= mins[i];
          clampedAny = true;
        }
      }
      if (!clampedAny) {
        for (let i = 0; i < n; i++) if (!clamped[i]) frac[i] = share(i);
        break;
      }
    }
  }
  return roundSpans(frac, available);
}

/** Cumulative rounding: child i gets `round(cum_{i+1}) - round(cum_i)`, so the
 *  integer spans sum exactly to `round(available)` with drift never accumulating. */
function roundSpans(frac: number[], available: number): number[] {
  const out = new Array<number>(frac.length);
  let cum = 0;
  let prevRounded = 0;
  const target = Math.round(available);
  for (let i = 0; i < frac.length; i++) {
    cum += frac[i];
    // Snap the final boundary to the target so integer spans tile exactly.
    const rounded = i === frac.length - 1 ? target : Math.round(cum);
    out[i] = rounded - prevRounded;
    prevRounded = rounded;
  }
  return out;
}

function layoutNode(node: LathNode, rect: Rect, opts: LayoutOpts, out: Map<LeafId, Rect>): void {
  if (node.kind === 'leaf') {
    out.set(node.id, rect);
    return;
  }
  const isRow = node.dir === 'row';
  const span = isRow ? rect.width : rect.height;
  const spans = allocateChildSpans(node.children, span, opts, node.dir);
  let pos = isRow ? rect.x : rect.y;
  for (let i = 0; i < node.children.length; i++) {
    const childRect: Rect = isRow
      ? { x: pos, y: rect.y, width: spans[i], height: rect.height }
      : { x: rect.x, y: pos, width: rect.width, height: spans[i] };
    layoutNode(node.children[i].node, childRect, opts, out);
    pos += spans[i] + opts.gap;
  }
}

/** Per-leaf rects that exactly tile `rect` minus gaps: integer pixels, no overlap,
 *  every leaf present. Weights are clamped against `minLeaf` at layout time only —
 *  stored weights are never rewritten. Negative/zero rects clamp to zero-size, never crash. */
export function layout(tree: LathTree, rect: Rect, opts: LayoutOpts): Map<LeafId, Rect> {
  const out = new Map<LeafId, Rect>();
  if (tree.root) layoutNode(tree.root, rect, opts, out);
  return out;
}

/** Rect of the interior/leaf node at `path` under the same geometry `layout` produces,
 *  or null if the path leaves the tree. Used by resize to convert px deltas to weights. */
export function nodeRectAtPath(tree: LathTree, rect: Rect, opts: LayoutOpts, path: number[]): Rect | null {
  let node = tree.root;
  if (!node) return null;
  let cur = rect;
  for (const idx of path) {
    if (node.kind !== 'split') return null;
    if (idx < 0 || idx >= node.children.length) return null;
    const isRow = node.dir === 'row';
    const span = isRow ? cur.width : cur.height;
    const spans = allocateChildSpans(node.children, span, opts, node.dir);
    let pos = isRow ? cur.x : cur.y;
    for (let i = 0; i < idx; i++) pos += spans[i] + opts.gap;
    cur = isRow
      ? { x: pos, y: cur.y, width: spans[idx], height: cur.height }
      : { x: cur.x, y: pos, width: cur.width, height: spans[idx] };
    node = node.children[idx].node;
  }
  return cur;
}

/** Nearest leaf in `direction`, replacing spatial-nav's DOM rect scanning
 *  (`findPaneInDirection`). Candidates must lie strictly beyond the current leaf's
 *  edge in that direction; overlapping candidates on the secondary axis win, then
 *  nearest edge-to-edge distance. Deterministic ties: smaller (y, x), then id.
 *  Callers pass the same `rect`/`opts` they render with. */
export function neighbors(
  tree: LathTree,
  rect: Rect,
  id: LeafId,
  direction: Direction,
  opts: LayoutOpts,
): LeafId | null {
  const rects = layout(tree, rect, opts);
  const c = rects.get(id);
  if (!c) return null;
  const isHorizontal = direction === 'left' || direction === 'right';

  type Cand = { id: LeafId; dist: number; overlaps: boolean; r: Rect };
  const cands: Cand[] = [];
  for (const [pid, r] of rects) {
    if (pid === id) continue;
    // Strictly beyond the current edge (boundary-touching candidates are kept).
    if (direction === 'left' && r.x + r.width > c.x) continue;
    if (direction === 'right' && r.x < c.x + c.width) continue;
    if (direction === 'up' && r.y + r.height > c.y) continue;
    if (direction === 'down' && r.y < c.y + c.height) continue;

    const overlaps = isHorizontal
      ? r.y < c.y + c.height && r.y + r.height > c.y
      : r.x < c.x + c.width && r.x + r.width > c.x;
    const dist = isHorizontal
      ? direction === 'left'
        ? c.x - (r.x + r.width)
        : r.x - (c.x + c.width)
      : direction === 'up'
        ? c.y - (r.y + r.height)
        : r.y - (c.y + c.height);
    cands.push({ id: pid, dist, overlaps, r });
  }

  const overlapping = cands.filter((cand) => cand.overlaps);
  const pool = overlapping.length > 0 ? overlapping : cands;
  pool.sort(
    (a, b) => a.dist - b.dist || a.r.y - b.r.y || a.r.x - b.r.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return pool[0]?.id ?? null;
}

/** The aspect-ratio split heuristic (`pickSplitDirection`): the leaf's laid-out rect
 *  wider than tall → `'right'`, else `'bottom'`. Missing leaf → `'right'`. */
export function autoEdge(tree: LathTree, rect: Rect, id: LeafId, opts: LayoutOpts): Edge {
  const r = layout(tree, rect, opts).get(id);
  if (!r) return 'right';
  return r.width - r.height > 0 ? 'right' : 'bottom';
}

/** One entry per adjacent child pair of every split: `boundary` is the boundary
 *  between children `boundary` and `boundary + 1`; `rect` is the gap band between
 *  them (thickness = `gap`, spanning the split's cross-axis). With `gap: 0` the band
 *  is the zero-thickness shared edge — the adapter widens the hit area. */
export function sashes(
  tree: LathTree,
  rect: Rect,
  opts: LayoutOpts,
): Array<{ splitPath: number[]; boundary: number; rect: Rect }> {
  const out: Array<{ splitPath: number[]; boundary: number; rect: Rect }> = [];
  const walk = (node: LathNode, r: Rect, path: number[]): void => {
    if (node.kind !== 'split') return;
    const isRow = node.dir === 'row';
    const span = isRow ? r.width : r.height;
    const spans = allocateChildSpans(node.children, span, opts, node.dir);
    let pos = isRow ? r.x : r.y;
    for (let i = 0; i < node.children.length; i++) {
      const childRect: Rect = isRow
        ? { x: pos, y: r.y, width: spans[i], height: r.height }
        : { x: r.x, y: pos, width: r.width, height: spans[i] };
      if (i < node.children.length - 1) {
        const bandStart = pos + spans[i];
        out.push({
          splitPath: path,
          boundary: i,
          rect: isRow
            ? { x: bandStart, y: r.y, width: opts.gap, height: r.height }
            : { x: r.x, y: bandStart, width: r.width, height: opts.gap },
        });
      }
      walk(node.children[i].node, childRect, [...path, i]);
      pos += spans[i] + opts.gap;
    }
  };
  if (tree.root) walk(tree.root, rect, []);
  return out;
}
