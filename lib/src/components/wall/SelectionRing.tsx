import { type Ref } from 'react';
import { cfg } from '../../cfg';
import { FOCUS_MOTION_MS } from '../design';

/** The ring outline: one closed rounded rect whose stroke centerline sits
 *  `inset` inside the container on every side. */
export function roundedRectPath(
  w: number,
  h: number,
  tl: number,
  tr: number,
  br: number,
  bl: number,
  inset: number,
): string {
  const { rtl, rtr, rbr, rbl, i } = ringCorners(tl, tr, br, bl, inset);
  return (
    `M ${w / 2},${i} ` +
    `L ${w - i - rtr},${i} ` +
    `Q ${w - i},${i} ${w - i},${i + rtr} ` +
    `L ${w - i},${h - i - rbr} ` +
    `Q ${w - i},${h - i} ${w - i - rbr},${h - i} ` +
    `L ${i + rbl},${h - i} ` +
    `Q ${i},${h - i} ${i},${h - i - rbl} ` +
    `L ${i},${i + rtl} ` +
    `Q ${i},${i} ${i + rtl},${i} ` +
    'Z'
  );
}

function ringCorners(tl: number, tr: number, br: number, bl: number, inset: number) {
  return {
    i: inset,
    rtl: Math.max(0, tl - inset),
    rtr: Math.max(0, tr - inset),
    rbr: Math.max(0, br - inset),
    rbl: Math.max(0, bl - inset),
  };
}

/** Perpendicular speed of each ring edge while it travels (px/ms), or null when
 *  settled. Each edge smears only by its OWN motion across itself — sliding
 *  along its own length leaves it unchanged — so the four are independent. */
export interface RingEdgeSpeeds {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The eight motion-smear pieces, in the order `SelectionRing` renders them and
 *  `WorkspaceSelectionOverlay` indexes the group's children. Straight edges take
 *  a plain `stroke-width`; corners taper between their two neighbours' widths
 *  via a `scale()` (see `smearCornerPath`). */
export const SMEAR_PIECES = ['top', 'right', 'bottom', 'left', 'tr', 'br', 'bl', 'tl'] as const;
export type SmearPiece = (typeof SMEAR_PIECES)[number];
export type RingCorner = 'tr' | 'br' | 'bl' | 'tl';
export type RingEdge = 'top' | 'right' | 'bottom' | 'left';

/** One edge's straight centerline, spanning the gap between its two corner arcs. */
export function smearEdgePath(
  edge: RingEdge,
  w: number, h: number,
  tl: number, tr: number, br: number, bl: number,
  inset: number,
): string {
  const { rtl, rtr, rbr, rbl, i } = ringCorners(tl, tr, br, bl, inset);
  switch (edge) {
    case 'top': return `M ${i + rtl},${i} L ${w - i - rtr},${i}`;
    case 'right': return `M ${w - i},${i + rtr} L ${w - i},${h - i - rbr}`;
    case 'bottom': return `M ${w - i - rbr},${h - i} L ${i + rbl},${h - i}`;
    case 'left': return `M ${i},${h - i - rbl} L ${i},${i + rtl}`;
  }
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
export function smearCornerPath(
  corner: RingCorner,
  w: number, h: number,
  tl: number, tr: number, br: number, bl: number,
  inset: number,
  a: number, b: number,
): string {
  const { rtl, rtr, rbr, rbl, i } = ringCorners(tl, tr, br, bl, inset);
  const X = (v: number) => v / a;
  const Y = (v: number) => v / b;
  switch (corner) {
    case 'tr':
      return `M ${X(w - i - rtr)},${Y(i)} Q ${X(w - i)},${Y(i)} ${X(w - i)},${Y(i + rtr)}`;
    case 'br':
      return `M ${X(w - i)},${Y(h - i - rbr)} Q ${X(w - i)},${Y(h - i)} ${X(w - i - rbr)},${Y(h - i)}`;
    case 'bl':
      return `M ${X(i + rbl)},${Y(h - i)} Q ${X(i)},${Y(h - i)} ${X(i)},${Y(h - i - rbl)}`;
    case 'tl':
      return `M ${X(i)},${Y(i + rtl)} Q ${X(i)},${Y(i)} ${X(i + rtl)},${Y(i)}`;
  }
}

// SelectionRing is a STABLE structural shell — it renders the ring's DOM once per
// variant/color/focus change and hands its nodes back through refs; the overlay
// then drives geometry, the path `d`, and the motion smear imperatively from its
// rAF loop (never per-frame React). This is the same split LathHost uses for the
// Lath animator: React owns structure, the animation frame owns the DOM mutations.
//
//  - `variant='ants'`: 2px dashed stroke, marching animation (the dash geometry and
//    `--march-offset` are written imperatively). Command-mode ring.
//  - `variant='solid'`: 1px stroke, no dash/animation. Passthrough ring, replacing
//    the retired 1px CSS border (pixel-identical stroke placement).
//
// Two layers, because the ring and its motion smear want incompatible geometry.
// The ring is ONE closed path so the marching-ants dash phase runs unbroken around
// the perimeter; the smear needs four independent edge widths, which a single
// stroke cannot carry. So the smear is a sibling group of eight solid pieces
// underneath, and the ring itself is never transformed or dashed differently —
// it stays exactly what it was before any smear existed.
//
// Geometry (`top/left/width/height`, every `d`, the smear widths/opacities, and
// the marching-ants dash) is NEVER in this JSX, so a React re-render of the shell
// leaves the imperative writes untouched.
export function SelectionRing({
  variant, color, windowFocused, containerRef, pathRef, smearRef,
}: {
  variant: 'ants' | 'solid';
  color: string;
  windowFocused: boolean;
  containerRef: Ref<HTMLDivElement>;
  pathRef: Ref<SVGPathElement>;
  smearRef: Ref<SVGGElement>;
}) {
  const ma = cfg.marchingAnts;
  const isAnts = variant === 'ants';

  return (
    <div
      ref={containerRef}
      style={{
        position: 'fixed',
        pointerEvents: 'none',
        zIndex: 50,
        // Geometry is written imperatively (see the overlay's rAF loop); only the
        // unfocus-saturate fade rides a CSS transition.
        transition: `filter ${FOCUS_MOTION_MS}ms`,
        filter: windowFocused ? undefined : 'saturate(0.3)',
      }}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}
      >
        {/* Smear first so it sits behind the ring. Hidden outright when settled,
            which is what keeps a resting ring byte-identical for Chromatic. */}
        <g ref={smearRef} data-ring="smear" style={{ display: 'none' }}>
          {SMEAR_PIECES.map((piece) => (
            <path
              key={piece}
              fill="none"
              stroke={color}
              // Corners are stroked at unit width and scaled; straight edges
              // overwrite this with their own width. Both are imperative.
              strokeWidth={1}
              transform-origin="0 0"
            />
          ))}
        </g>
        <path
          ref={pathRef}
          // Stable hook: the smear group renders eight paths ahead of this one,
          // so positional selectors no longer find the ring.
          data-ring="outline"
          fill="none"
          stroke={color}
          strokeWidth={isAnts ? ma.strokeWidth : 1}
          style={isAnts ? {
            animation: `marching-ants ${ma.cycleDuration}s linear infinite`,
            animationPlayState: (ma.paused || !windowFocused) ? 'paused' : 'running',
          } : undefined}
        />
      </svg>
    </div>
  );
}
