import { type Ref } from 'react';
import { cfg } from '../../cfg';
import { FOCUS_MOTION_MS } from '../design';

export function roundedRectPath(
  w: number,
  h: number,
  tl: number,
  tr: number,
  br: number,
  bl: number,
  inset: number,
): string {
  const i = inset;
  const rtl = Math.max(0, tl - i);
  const rtr = Math.max(0, tr - i);
  const rbr = Math.max(0, br - i);
  const rbl = Math.max(0, bl - i);
  const mx = w / 2;
  return (
    `M ${mx},${i} ` +
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

/** Per-axis center velocity of the ring while it travels (px/ms), or null when
 *  settled. Drives the directional motion-blur filter. */
export interface RingVelocity {
  x: number;
  y: number;
}

// SelectionRing is a STABLE structural shell — it renders the ring's DOM once per
// variant/color/focus change and hands its nodes back through refs; the overlay
// then drives geometry, the path `d`, and the blur filter imperatively from its rAF
// loop (never per-frame React). This is the same split LathHost uses for the Lath
// animator: React owns structure, the animation frame owns the DOM mutations. It
// matters because WebKit rasterizes the SVG blur on the CPU every frame, so a
// per-frame React reconcile of this subtree competes with that raster for the frame
// budget and makes Safari choppy.
//
//  - `variant='ants'`: 2px dashed stroke, marching animation (the dash geometry and
//    `--march-offset` are written imperatively). Command-mode ring.
//  - `variant='solid'`: 1px stroke, no dash/animation. Passthrough ring, replacing
//    the retired 1px CSS border (pixel-identical stroke placement).
//
// Geometry (`top/left/width/height`, `d`, the blur `<filter>` region/`stdDeviation`,
// and the marching-ants dash) is NEVER in this JSX, so a React re-render of the
// shell leaves the imperative writes untouched.
export function SelectionRing({
  variant, color, windowFocused, filterId, containerRef, pathRef, filterRef, blurRef,
}: {
  variant: 'ants' | 'solid';
  color: string;
  windowFocused: boolean;
  filterId: string;
  containerRef: Ref<HTMLDivElement>;
  pathRef: Ref<SVGPathElement>;
  filterRef: Ref<SVGFilterElement>;
  blurRef: Ref<SVGFEGaussianBlurElement>;
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
        {/* Always present (region + stdDeviation set imperatively); the path only
            references it via a `filter` attr while actually moving. sRGB
            interpolation (not the filter default linearRGB) keeps the blurred smear
            the ring's true color/brightness instead of muddying it. */}
        <filter ref={filterRef} id={filterId} filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feGaussianBlur ref={blurRef} />
        </filter>
        <path
          ref={pathRef}
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
