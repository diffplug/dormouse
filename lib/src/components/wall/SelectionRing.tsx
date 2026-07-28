import { type Ref } from 'react';
import { cfg } from '../../cfg';
import { FOCUS_MOTION_MS } from '../design';

/**
 * The ring outline. `sx`/`sy` pre-divide every coordinate so that a caller which
 * then applies `transform: scale(sx, sy)` gets back *pixel-identical* geometry —
 * same inset, same corner radii — while the stroke scales anisotropically. That
 * is the motion-smear trick in `WorkspaceSelectionOverlay`: SVG stroke width is
 * a single scalar, so per-edge widths can only come from a non-uniform scale.
 *
 * Dividing x and y independently is what keeps the corners honest: a quarter
 * circle of radius r must be drawn as an ellipse with semi-axes (r/sx, r/sy) to
 * land back on a circle after the scale. Defaults of 1 leave the path untouched.
 */
export function roundedRectPath(
  w: number,
  h: number,
  tl: number,
  tr: number,
  br: number,
  bl: number,
  inset: number,
  sx = 1,
  sy = 1,
): string {
  const rtl = Math.max(0, tl - inset);
  const rtr = Math.max(0, tr - inset);
  const rbr = Math.max(0, br - inset);
  const rbl = Math.max(0, bl - inset);
  // Every literal below is a post-scale (on-screen) coordinate; X/Y divide it
  // back into the pre-scale space the path is actually authored in.
  const X = (v: number) => v / sx;
  const Y = (v: number) => v / sy;
  return (
    `M ${X(w / 2)},${Y(inset)} ` +
    `L ${X(w - inset - rtr)},${Y(inset)} ` +
    `Q ${X(w - inset)},${Y(inset)} ${X(w - inset)},${Y(inset + rtr)} ` +
    `L ${X(w - inset)},${Y(h - inset - rbr)} ` +
    `Q ${X(w - inset)},${Y(h - inset)} ${X(w - inset - rbr)},${Y(h - inset)} ` +
    `L ${X(inset + rbl)},${Y(h - inset)} ` +
    `Q ${X(inset)},${Y(h - inset)} ${X(inset)},${Y(h - inset - rbl)} ` +
    `L ${X(inset)},${Y(inset + rtl)} ` +
    `Q ${X(inset)},${Y(inset)} ${X(inset + rtl)},${Y(inset)} ` +
    'Z'
  );
}

/** Per-axis center velocity of the ring while it travels (px/ms), or null when
 *  settled. Drives the directional motion-blur filter. */
export interface RingVelocity {
  x: number;
  y: number;
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
// Geometry (`top/left/width/height`, `d`, the smear `transform`/`stroke-opacity`,
// and the marching-ants dash) is NEVER in this JSX, so a React re-render of the
// shell leaves the imperative writes untouched.
export function SelectionRing({
  variant, color, windowFocused, containerRef, pathRef,
}: {
  variant: 'ants' | 'solid';
  color: string;
  windowFocused: boolean;
  containerRef: Ref<HTMLDivElement>;
  pathRef: Ref<SVGPathElement>;
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
        <path
          ref={pathRef}
          fill="none"
          stroke={color}
          strokeWidth={isAnts ? ma.strokeWidth : 1}
          // The smear scales the path about the SVG origin, which is the
          // container's top-left — so no transform-origin bookkeeping.
          transform-origin="0 0"
          style={isAnts ? {
            animation: `marching-ants ${ma.cycleDuration}s linear infinite`,
            animationPlayState: (ma.paused || !windowFocused) ? 'paused' : 'running',
          } : undefined}
        />
      </svg>
    </div>
  );
}
