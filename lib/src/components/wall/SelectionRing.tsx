import { type Ref } from 'react';
import { cfg } from '../../cfg';
import { RING_PIECES } from '../../lib/ring-geometry';
import { FOCUS_MOTION_MS } from '../design';

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
          {RING_PIECES.map((piece) => (
            <path
              key={piece}
              // Looked up by name, never by index — render order here is
              // presentational and must not be load-bearing.
              data-piece={piece}
              fill="none"
              stroke={color}
              // Corners are stroked at unit width and scaled; straight edges
              // overwrite this with their own width. Both are imperative.
              strokeWidth={1}
              // The CSS property, not the SVG presentation attribute: React
              // knows that attribute only as `transformOrigin`, which
              // `@types/react` does not declare, and the hyphenated spelling
              // reaches the DOM only while logging `Invalid DOM property` on
              // every render. Same effect on the corners' `scale(...)`.
              style={{ transformOrigin: '0 0' }}
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
