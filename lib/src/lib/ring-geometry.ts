// Focus-ring outline geometry — pure `(numbers) → SVG path string`, no DOM or
// React (the same contract as selection-geometry.ts and rect-tween.ts). The ring
// is drawn as ONE closed path so the marching-ants dash phase runs unbroken
// around the perimeter; its motion smear is drawn as EIGHT separate pieces
// underneath, because SVG `stroke-width` is a single scalar and the four edges
// need independent widths. Both come from the point set below, so the smear
// provably tiles the ring instead of agreeing with it by inspection.
//
// See `docs/specs/layout.md` → "Ring travel" for why the smear is a separate
// layer and how the corner taper works.

import type { RingRect, RingShape } from './rect-tween';

export type RingEdge = 'top' | 'right' | 'bottom' | 'left';
export type RingCorner = 'tr' | 'br' | 'bl' | 'tl';
export type RingPiece = RingEdge | RingCorner;

const RING_EDGES = ['top', 'right', 'bottom', 'left'] as const;
const RING_CORNERS = ['tr', 'br', 'bl', 'tl'] as const;

/** Every smear piece, edges first. `SelectionRing` renders one `<path>` per entry
 *  and tags it `data-piece`; the overlay looks them up by that name, never by
 *  index, so this order is presentational only. */
export const RING_PIECES: readonly RingPiece[] = [...RING_EDGES, ...RING_CORNERS];

/** The two edges each corner joins, as `[vertical, horizontal]` — the order
 *  `cornerPath` expects its `(a, b)` scale pair in. */
export const CORNER_EDGES: Record<RingCorner, readonly [RingEdge, RingEdge]> = {
  tr: ['right', 'top'],
  br: ['right', 'bottom'],
  bl: ['left', 'bottom'],
  tl: ['left', 'top'],
};

export function isRingCorner(piece: RingPiece): piece is RingCorner {
  return piece in CORNER_EDGES;
}

type Point = readonly [x: number, y: number];

/**
 * Every anchor the ring is built from, derived once.
 *
 * Each edge is the straight run between two corner arcs; each corner is a
 * quadratic from its incoming tangent point, through the box corner as control,
 * to its outgoing tangent point. Corner radii are shrunk by the inset so the
 * stroke centerline stays concentric with the pane it surrounds
 * (`docs/specs/layout.md` → Concentric-Corners Rule).
 */
function ringPoints(rect: RingRect, shape: RingShape) {
  const { width: w, height: h } = rect;
  const i = shape.inset;
  const rtl = Math.max(0, shape.tl - i);
  const rtr = Math.max(0, shape.tr - i);
  const rbr = Math.max(0, shape.br - i);
  const rbl = Math.max(0, shape.bl - i);
  return {
    edges: {
      top: [[i + rtl, i], [w - i - rtr, i]],
      right: [[w - i, i + rtr], [w - i, h - i - rbr]],
      bottom: [[w - i - rbr, h - i], [i + rbl, h - i]],
      left: [[i, h - i - rbl], [i, i + rtl]],
    },
    corners: {
      tr: [[w - i - rtr, i], [w - i, i], [w - i, i + rtr]],
      br: [[w - i, h - i - rbr], [w - i, h - i], [w - i - rbr, h - i]],
      bl: [[i + rbl, h - i], [i, h - i], [i, h - i - rbl]],
      tl: [[i, i + rtl], [i, i], [i + rtl, i]],
    },
    /** Where the closed outline starts: the midpoint of the top edge. */
    start: [w / 2, i] as Point,
  } as {
    edges: Record<RingEdge, readonly [Point, Point]>;
    corners: Record<RingCorner, readonly [Point, Point, Point]>;
    start: Point;
  };
}

const fmt = ([x, y]: Point, sx = 1, sy = 1) => `${x / sx},${y / sy}`;

/** The ring outline: one closed rounded rect whose stroke centerline sits
 *  `shape.inset` inside the container on every side. */
export function roundedRectPath(rect: RingRect, shape: RingShape): string {
  const { corners, start } = ringPoints(rect, shape);
  // Each corner's first point is exactly the preceding edge's end, so walking the
  // corners in order traces the whole perimeter — and traces it through the same
  // anchors the smear pieces are cut from.
  const arcs = RING_CORNERS.map((corner) => {
    const [from, ctrl, to] = corners[corner];
    return `L ${fmt(from)} Q ${fmt(ctrl)} ${fmt(to)} `;
  }).join('');
  return `M ${fmt(start)} ${arcs}Z`;
}

/** One edge's straight centerline, spanning the gap between its two corner arcs. */
export function edgePath(edge: RingEdge, rect: RingRect, shape: RingShape): string {
  const [from, to] = ringPoints(rect, shape).edges[edge];
  return `M ${fmt(from)} L ${fmt(to)}`;
}

/**
 * One corner's quarter-arc centerline, pre-divided by `(a, b)` so that a sibling
 * `transform: scale(a, b)` restores the on-screen arc exactly.
 *
 * The scale is what makes the corner taper. Under `scale(a, b)` a unit stroke
 * renders `b` thick where the tangent is horizontal and `a` thick where it is
 * vertical, interpolating smoothly in between — so passing the horizontal
 * neighbour's width as `b` and the vertical neighbour's as `a` blends the corner
 * between its two edges with no seam at either join. That is the whole reason
 * corners are separate elements: a straight edge can carry its own width in a
 * plain `stroke-width`, but a corner has to reach two different widths at once.
 */
export function cornerPath(
  corner: RingCorner,
  rect: RingRect,
  shape: RingShape,
  a: number,
  b: number,
): string {
  const [from, ctrl, to] = ringPoints(rect, shape).corners[corner];
  return `M ${fmt(from, a, b)} Q ${fmt(ctrl, a, b)} ${fmt(to, a, b)}`;
}
