// Lath hit-testing: turns a pointer over the laid-out wall into the one drop it would
// commit, carrying the EXACT preview rect of that commit (speculatively run
// `move`/`insert` + `layout`, never a heuristic hint zone). Pure and renderer-agnostic —
// points arrive already in Wall coordinates (the HTML adapter feeds pointer offsets; a
// Three.js adapter feeds raycast intersections). No DOM, React, or timing. See
// docs/specs/tiling-engine.md ("Hierarchical drag and drop").

import { type Edge, type LathTree, type LeafId, type Rect, edgeAxis, findLeafPath, leaves, nodeAtPath, rectsClose } from './model';
import { type LayoutOpts, layout, nodeRectAtPath } from './layout';
import { type DropTarget, insert, move } from './ops';
import { materializeTarget, targetRect } from './drop-target';

export type DropCandidate = {
  target: DropTarget;
  previewRect: Rect;
  /** On-screen bounds of what the drop goes beside (the hovered leaf for a swap). */
  scopeRect: Rect;
  /** Leaves in that scope, not counting the dragged one. */
  scopeLeafCount: number;
};

/** One boundary line a slide moves along. Positions run along the line (x for
 *  top/bottom, y for left/right) in Wall coordinates. */
export type SlideGuide = {
  edge: Edge;
  /** The line's position across it: y for top/bottom, x for left/right. */
  line: number;
  /** How far a slide from the anchor (or, before one, from here) can reach. */
  extent: [number, number];
  /** Where crossing the line steps the scope to the next pane or group, inside `extent`. */
  stops: number[];
  /** The chosen scope's span. */
  scope: [number, number];
};

export type DropHit = {
  candidate: DropCandidate | null;
  /** The line an edge drop can slide along. Null for a swap, a miss, a line that offers
   *  only one scope, or an unanchored drop that would do nothing; an anchored slide keeps
   *  it through such scopes, so the way back stays on screen. */
  guide: SlideGuide | null;
  /** The anchor still lies on the hovered edge's line, so the slide continues. False
   *  when there was no anchor, or the pointer left that line (the caller drops it). */
  anchored: boolean;
};

type Point = { x: number; y: number };
type Hover = { leafId: LeafId; leafRect: Rect; bands: Edge[] };
type Scope = { target: DropTarget & { kind: 'edge' }; start: number; end: number };

/** Placeholder leaf id for the speculative `insert` of an external (Door) drag. */
const EXTERNAL_ID = '__lath_external_drop__';

/** Edge band = this fraction of the leaf's extent on the band's axis, capped at
 *  `MAX_BAND` px, so a huge leaf still has a graspable center. */
const BAND_FRACTION = 0.3;
const MAX_BAND = 96;
/** Tolerance (px) for boundaries "coinciding" and spans covering a slide. */
const COINCIDE_EPS = 0.5;

function edgeCoord(r: Rect, edge: Edge): number {
  switch (edge) {
    case 'left':
      return r.x;
    case 'right':
      return r.x + r.width;
    case 'top':
      return r.y;
    case 'bottom':
      return r.y + r.height;
  }
}

/** The span a rect covers along an edge's line: x for top/bottom, y for left/right. */
function spanAlong(r: Rect, edge: Edge): [number, number] {
  return edgeAxis(edge) === 'col' ? [r.x, r.x + r.width] : [r.y, r.y + r.height];
}

function alongOf(p: Point, edge: Edge): number {
  return edgeAxis(edge) === 'col' ? p.x : p.y;
}

/** Distance from `(x, y)` to the nearest point of `r` (0 when inside). */
function distToRect(r: Rect, x: number, y: number): number {
  const dx = Math.max(r.x - x, 0, x - (r.x + r.width));
  const dy = Math.max(r.y - y, 0, y - (r.y + r.height));
  return Math.hypot(dx, dy);
}

function sameLayout(a: Map<LeafId, Rect>, b: Map<LeafId, Rect>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, ra] of a) {
    const rb = b.get(id);
    if (!rb || !rectsClose(ra, rb)) return false;
  }
  return true;
}

/** The leaf under `p` and its in-band edges, nearest first. A point in a gap (or a
 *  hairline overshoot) attributes to the nearest leaf, so boundaries have no dead zones. */
function hover(rects: Map<LeafId, Rect>, p: Point): Hover | null {
  let found: Hover | null = null;
  let best = Infinity;
  for (const [id, r] of rects) {
    const d = distToRect(r, p.x, p.y);
    if (d < best) {
      best = d;
      found = { leafId: id, leafRect: r, bands: [] };
      if (d === 0) break;
    }
  }
  if (!found) return null;
  const r = found.leafRect;
  const bandX = Math.min(BAND_FRACTION * r.width, MAX_BAND);
  const bandY = Math.min(BAND_FRACTION * r.height, MAX_BAND);
  const bands: Array<{ edge: Edge; dist: number }> = [];
  const dl = p.x - r.x;
  const dr = r.x + r.width - p.x;
  const dt = p.y - r.y;
  const db = r.y + r.height - p.y;
  if (dl < bandX) bands.push({ edge: 'left', dist: dl });
  if (dr < bandX) bands.push({ edge: 'right', dist: dr });
  if (dt < bandY) bands.push({ edge: 'top', dist: dt });
  if (db < bandY) bands.push({ edge: 'bottom', dist: db });
  // The nearest in-band edge wins the corner; deterministic tie-break by edge order.
  const rank: Record<Edge, number> = { left: 0, right: 1, top: 2, bottom: 3 };
  bands.sort((a, b) => a.dist - b.dist || rank[a.edge] - rank[b.edge]);
  found.bands = bands.map((b) => b.edge);
  return found;
}

type LineAncestor = {
  path: number[];
  span: [number, number];
  /** Each child's span, when the ancestor's children run along the line. */
  childSpans: Array<[number, number]> | null;
};

/** The leaf's ancestors whose `edge` lies on the leaf's line, innermost first. */
function ancestorsOnLine(
  tree: LathTree, rect: Rect, opts: LayoutOpts, leafPath: number[], leafRect: Rect, edge: Edge,
): LineAncestor[] {
  const line = edgeCoord(leafRect, edge);
  const out: LineAncestor[] = [];
  for (let k = leafPath.length - 1; k >= 0; k--) {
    const path = leafPath.slice(0, k);
    const ar = nodeRectAtPath(tree, rect, opts, path);
    if (!ar || Math.abs(edgeCoord(ar, edge) - line) > COINCIDE_EPS) continue;
    const ancestor = nodeAtPath(tree, path);
    const childSpans = ancestor?.kind === 'split' && ancestor.dir !== edgeAxis(edge)
      ? ancestor.children.map((_, i) => spanAlong(nodeRectAtPath(tree, rect, opts, [...path, i])!, edge))
      : null;
    out.push({ path, span: spanAlong(ar, edge), childSpans });
  }
  return out;
}

/** Every scope whose `edge` lies on the hovered leaf's line, innermost first: the leaf,
 *  then each ancestor sharing that boundary. Where an ancestor's children run along the
 *  line, the adjacent children covering `[lo, hi]` also form a range scope. */
function scopesOnLine(
  tree: LathTree, rect: Rect, opts: LayoutOpts, leafPath: number[], leafRect: Rect, edge: Edge, lo: number, hi: number,
): Scope[] {
  const [ls, le] = spanAlong(leafRect, edge);
  const out: Scope[] = [{ target: { kind: 'edge', path: leafPath, edge }, start: ls, end: le }];
  for (const { path, span, childSpans: spans } of ancestorsOnLine(tree, rect, opts, leafPath, leafRect, edge)) {
    if (spans) {
      const first = spans.findIndex(([, end]) => end >= lo - COINCIDE_EPS);
      let last = spans.length - 1;
      while (last > 0 && spans[last][0] > hi + COINCIDE_EPS) last--;
      if (first >= 0 && last > first && last - first + 1 < spans.length) {
        out.push({ target: { kind: 'edge', path, edge, range: { start: first, end: last + 1 } }, start: spans[first][0], end: spans[last][1] });
      }
    }
    out.push({ target: { kind: 'edge', path, edge }, start: span[0], end: span[1] });
  }
  return out;
}

/** The line a slide from `leafPath` moves along: its reach is the outermost ancestor
 *  sharing the line, and it steps at each gutter between children laid along it. Null
 *  when the leaf is the only scope the line offers. */
function slideLine(
  tree: LathTree, rect: Rect, opts: LayoutOpts, leafPath: number[], leafRect: Rect, edge: Edge,
): Omit<SlideGuide, 'scope'> | null {
  const ancestors = ancestorsOnLine(tree, rect, opts, leafPath, leafRect, edge);
  const stops = new Set<number>();
  for (const { childSpans } of ancestors) {
    for (let i = 1; i < (childSpans?.length ?? 0); i++) stops.add((childSpans![i - 1][1] + childSpans![i][0]) / 2);
  }
  const leafSpan = spanAlong(leafRect, edge);
  const extent = ancestors.length > 0 ? ancestors[ancestors.length - 1].span : leafSpan;
  if (stops.size === 0 && extent[0] >= leafSpan[0] - COINCIDE_EPS && extent[1] <= leafSpan[1] + COINCIDE_EPS) return null;
  return { edge, line: edgeCoord(leafRect, edge), extent, stops: [...stops].sort((a, b) => a - b) };
}

/** The drop under `point`, or `null` when it misses the wall or the drop would be
 *  rejected or a beside-itself no-op. `dragged` is the leaf being dragged (`null` for
 *  an external Door drag, which yields no `swap` and previews via `insert`).
 *
 *  A leaf's center region swaps; its edge bands drop beside it. `anchor` is where a
 *  slide along an edge began: while the pointer stays on that boundary line, the scope
 *  is the smallest one — the leaf, a contiguous range of an ancestor's children, or a
 *  whole ancestor — whose edge spans from the anchor to the pointer. Without an anchor
 *  the scope is the hovered leaf alone.
 *
 *  The pointer is hit-tested against the layout WITHOUT removing `dragged`: it may
 *  hover its own slot, and self-targeting drops fall out through the filters. */
export function hitTest(
  tree: LathTree,
  rect: Rect,
  point: Point,
  dragged: LeafId | null,
  opts: LayoutOpts,
  anchor: Point | null = null,
): DropHit {
  const miss: DropHit = { candidate: null, anchored: false, guide: null };
  if (tree.root === null) return miss;
  if (point.x < rect.x || point.x > rect.x + rect.width || point.y < rect.y || point.y > rect.y + rect.height) {
    return miss;
  }

  const rects = layout(tree, rect, opts);
  const here = hover(rects, point);
  if (!here) return miss;
  const leafPath = findLeafPath(tree, here.leafId);
  if (leafPath === null) return miss;

  let previewId = dragged ?? EXTERNAL_ID;
  if (dragged === null) while (rects.has(previewId)) previewId += '_';
  const evaluate = (target: DropTarget): Rect | null => {
    const r = dragged !== null ? move(tree, dragged, target) : insert(tree, previewId, target);
    if (!r.ok) return null;
    const resultRects = layout(r.tree, rect, opts);
    // Beside-itself: a committed layout identical to the current one is not a real move.
    if (dragged !== null && target.kind === 'edge' && sameLayout(rects, resultRects)) return null;
    return resultRects.get(previewId) ?? null;
  };

  // A live slide keeps its edge through the corners it crosses, as long as the hovered
  // leaf still has that edge in band and on the anchor's line.
  const from = anchor ? hover(rects, anchor) : null;
  const slideEdge = from?.bands[0];
  const anchored = slideEdge !== undefined && here.bands.includes(slideEdge)
    && Math.abs(edgeCoord(here.leafRect, slideEdge) - edgeCoord(from!.leafRect, slideEdge)) <= COINCIDE_EPS;
  const edge = anchored ? slideEdge : here.bands[0];

  if (edge === undefined) {
    // Center → swap (internal only; never with yourself).
    if (dragged === null || here.leafId === dragged) return miss;
    const target: DropTarget = { kind: 'swap', leaf: here.leafId };
    const previewRect = evaluate(target);
    return {
      candidate: previewRect && { target, previewRect, scopeRect: here.leafRect, scopeLeafCount: 1 },
      anchored: false,
      guide: null,
    };
  }

  // The slide's extent along the line, each end clamped to the leaf it lies in so a
  // pointer crossing a gap never reaches the next leaf early.
  const clampTo = (r: Rect, p: Point): number => {
    const [s, e] = spanAlong(r, edge);
    return Math.min(Math.max(alongOf(p, edge), s), e);
  };
  const at = clampTo(here.leafRect, point);
  const start = anchored ? clampTo(from!.leafRect, anchor!) : at;
  const lo = Math.min(start, at);
  const hi = Math.max(start, at);

  const scopes = scopesOnLine(tree, rect, opts, leafPath, here.leafRect, edge, lo, hi);
  // The smallest scope spanning the slide; on a tie the innermost wins, since tied
  // scopes differ only in the new pane's size.
  let scope: Scope | null = null;
  for (const s of scopes) {
    if (s.start > lo + COINCIDE_EPS || s.end < hi - COINCIDE_EPS) continue;
    if (!scope || s.end - s.start < scope.end - scope.start - COINCIDE_EPS) scope = s;
  }
  // An anchor whose line no common ancestor spans cannot continue; the caller drops it.
  if (!scope) return miss;
  // The line is the anchor's: a slide reaches only scopes holding the anchor's leaf.
  const origin = anchored ? from! : here;
  const line = slideLine(tree, rect, opts, findLeafPath(tree, origin.leafId)!, origin.leafRect, edge);
  const guide: SlideGuide | null = line && { ...line, scope: [scope.start, scope.end] };
  const previewRect = evaluate(scope.target);
  if (!previewRect) return { candidate: null, anchored, guide: anchored ? guide : null };
  const materialized = materializeTarget(tree, scope.target)!;
  const scopeLeaves = leaves({ root: nodeAtPath(materialized.tree, materialized.path) });
  return {
    candidate: {
      target: scope.target,
      previewRect,
      scopeRect: targetRect(tree, rect, opts, scope.target)!,
      scopeLeafCount: scopeLeaves.filter((id) => id !== dragged).length,
    },
    anchored,
    guide,
  };
}
