// Lath hit-testing: turns a pointer over the laid-out wall into an ordered list of
// drop candidates (innermost → outermost), each carrying the EXACT preview rect its
// commit would produce (speculatively run `move`/`insert` + `layout`, never a
// heuristic hint zone). Pure and renderer-agnostic — the point arrives already in
// Wall coordinates (the HTML adapter feeds pointer offsets; a Three.js adapter feeds
// raycast intersections). No DOM, React, or timing. See docs/specs/tiling-engine.md
// ("Hierarchical drag and drop").

import { type Edge, type LathTree, type LeafId, type Rect, findLeafPath, rectsClose } from './model';
import { type LayoutOpts, layout, nodeRectAtPath } from './layout';
import { type DropTarget, insert, move } from './ops';

export type DropCandidate = { target: DropTarget; previewRect: Rect; depth: number };

/** Placeholder leaf id for the speculative `insert` of an external (Door) drag. */
const EXTERNAL_ID = '__lath_external_drop__';

/** Edge band = this fraction of the leaf's extent on the band's axis, capped at
 *  `MAX_BAND` px, so a huge leaf still has a graspable center. */
const BAND_FRACTION = 0.3;
const MAX_BAND = 96;
/** Tolerance (px) for an ancestor's boundary "coinciding" with the hovered leaf's. */
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

/** Ordered drop candidates for a pointer over the wall, innermost (`depth` 0) →
 *  outermost. `dragged` is the leaf being dragged (`null` for an external Door drag,
 *  which yields no `swap` and previews via `insert`). Empty when the point misses the
 *  wall or every candidate is a rejected op / a beside-itself no-op / a duplicate of a
 *  closer candidate's result.
 *
 *  The pointer is hit-tested against the layout WITHOUT removing `dragged`: it may
 *  hover its own slot, and self-targeting candidates fall out through the filters. */
export function hitTest(
  tree: LathTree,
  rect: Rect,
  point: { x: number; y: number },
  dragged: LeafId | null,
  opts: LayoutOpts,
): DropCandidate[] {
  if (tree.root === null) return [];
  // Off-wall → no candidates.
  if (point.x < rect.x || point.x > rect.x + rect.width || point.y < rect.y || point.y > rect.y + rect.height) {
    return [];
  }

  const rects = layout(tree, rect, opts);
  // Leaf under the point; a point in a gap (or a hairline overshoot) attributes to the
  // nearest leaf so there are no dead zones along split boundaries.
  let leafId: LeafId | null = null;
  let leafRect: Rect | null = null;
  let best = Infinity;
  for (const [id, r] of rects) {
    if (point.x >= r.x && point.x <= r.x + r.width && point.y >= r.y && point.y <= r.y + r.height) {
      leafId = id;
      leafRect = r;
      break;
    }
    const d = distToRect(r, point.x, point.y);
    if (d < best) {
      best = d;
      leafId = id;
      leafRect = r;
    }
  }
  if (leafId === null || leafRect === null) return [];

  const leafPath = findLeafPath(tree, leafId);
  if (leafPath === null) return [];

  // Region within the leaf: an edge band per side (thickness capped), else the center.
  const bandX = Math.min(BAND_FRACTION * leafRect.width, MAX_BAND);
  const bandY = Math.min(BAND_FRACTION * leafRect.height, MAX_BAND);
  const dl = point.x - leafRect.x;
  const dr = leafRect.x + leafRect.width - point.x;
  const dt = point.y - leafRect.y;
  const db = leafRect.y + leafRect.height - point.y;
  const bands: Array<{ edge: Edge; dist: number }> = [];
  if (dl < bandX) bands.push({ edge: 'left', dist: dl });
  if (dr < bandX) bands.push({ edge: 'right', dist: dr });
  if (dt < bandY) bands.push({ edge: 'top', dist: dt });
  if (db < bandY) bands.push({ edge: 'bottom', dist: db });

  const raw: DropTarget[] = [];
  if (bands.length === 0) {
    // Center → swap (internal only; never with yourself).
    if (dragged !== null && leafId !== dragged) raw.push({ kind: 'swap', leaf: leafId });
  } else {
    // The nearest in-band edge wins the corner; deterministic tie-break by edge order.
    const rank: Record<Edge, number> = { left: 0, right: 1, top: 2, bottom: 3 };
    bands.sort((a, b) => a.dist - b.dist || rank[a.edge] - rank[b.edge]);
    const edge = bands[0].edge;
    // Innermost: this leaf's own level. Then each ancestor (up to the root, path []) whose
    // `edge` boundary coincides with the hovered leaf's — "beside this whole column/row".
    raw.push({ kind: 'edge', path: leafPath, edge });
    for (let k = leafPath.length - 1; k >= 0; k--) {
      const ancestorPath = leafPath.slice(0, k);
      const ar = nodeRectAtPath(tree, rect, opts, ancestorPath);
      if (ar && Math.abs(edgeCoord(ar, edge) - edgeCoord(leafRect, edge)) <= COINCIDE_EPS) {
        raw.push({ kind: 'edge', path: ancestorPath, edge });
      }
    }
  }

  // Speculatively commit each candidate; drop rejected ops, beside-itself no-ops, and
  // duplicates (candidates that land the moved leaf in the same place — the flatten
  // invariant collapses some ancestor levels into their child's result).
  const out: DropCandidate[] = [];
  const seen = new Set<string>();
  const previewId = dragged !== null ? dragged : EXTERNAL_ID;
  for (const target of raw) {
    const r = dragged !== null ? move(tree, dragged, target) : insert(tree, previewId, target);
    if (!r.ok) continue;
    const resultRects = layout(r.tree, rect, opts);
    const pr = resultRects.get(previewId);
    if (!pr) continue;
    // Beside-itself: a committed layout identical to the current one is not a real move.
    if (dragged !== null && target.kind === 'edge' && sameLayout(rects, resultRects)) continue;
    const key = `${pr.x},${pr.y},${pr.width},${pr.height}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ target, previewRect: pr, depth: out.length });
  }
  return out;
}
