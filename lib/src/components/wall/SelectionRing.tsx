import { useId, useLayoutEffect, useRef, useState } from 'react';
import { cfg } from '../../cfg';

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
 *  settled. Drives the experimental 'directional' motion-blur filter. */
export interface RingVelocity {
  x: number;
  y: number;
}

/** One trail ghost, in the live ring's local SVG coordinates: `dx/dy` offset it
 *  from the live rect's top-left (the SVG origin) so a past position renders inside
 *  the same overflow-visible SVG as the live path. Experimental 'trail' mode only. */
export interface RingGhost {
  dx: number;
  dy: number;
  width: number;
  height: number;
  tl: number;
  tr: number;
  br: number;
  bl: number;
}

// The corner radii and stroke `inset` are computed by the overlay
// (WorkspaceSelectionOverlay's `ringShape`) and lerped by the ring tween, so a
// pane↔door selection morphs its shape here instead of popping.
//
//  - `variant='ants'`: 2px dashed stroke, marching animation, using the shape's
//    lerped `inset` (pane 0.5 ⇄ door 1) so the centerline stays on the gutter
//    midline. This is the command-mode ring.
//  - `variant='solid'`: 1px stroke, no dash/animation, replacing the retired 1px
//    CSS border in passthrough mode. It ignores the shape's `inset` and centers
//    its stroke a fixed strokeWidth/2 (0.5) inside the div edge — pixel-identical
//    to the old border for both panes and doors (whose solid insets coincide),
//    while that `inset` channel keeps carrying the ants-only morph.
//
// `velocity` and `ghosts` are the two experimental motion treatments behind
// `cfg.focusRing.motionBlur`; both are absent on a settled ring, so a resting or
// reduced-motion render is always clean (no filter, no ghost paths).
export function SelectionRing({
  variant, width, height, tl, tr, br, bl, inset, color, paused, velocity, ghosts,
}: {
  variant: 'ants' | 'solid';
  width: number;
  height: number;
  tl: number;
  tr: number;
  br: number;
  bl: number;
  inset: number;
  color: string;
  paused?: boolean;
  velocity?: RingVelocity | null;
  ghosts?: RingGhost[];
}) {
  const svgRef = useRef<SVGPathElement>(null);
  const [dashStyle, setDashStyle] = useState<{ dasharray: string; offset: number } | null>(null);
  const rawId = useId();
  const ma = cfg.marchingAnts;
  const fr = cfg.focusRing;

  const isAnts = variant === 'ants';
  const strokeWidth = isAnts ? ma.strokeWidth : 1;
  const effInset = isAnts ? inset : strokeWidth / 2;

  const d = roundedRectPath(width, height, tl, tr, br, bl, effInset);

  useLayoutEffect(() => {
    // Solid has no dash sizing; leave `dashStyle` null (no getTotalLength either).
    if (!isAnts) {
      setDashStyle(null);
      return;
    }
    const path = svgRef.current;
    if (!path) return;
    const len = path.getTotalLength();
    const count = Math.max(1, Math.round(len / ma.segLen));
    const adjusted = len / count;
    const dash = adjusted * ma.dashFraction;
    const gap = adjusted * (1 - ma.dashFraction);
    setDashStyle({ dasharray: `${dash} ${gap}`, offset: adjusted });
  }, [isAnts, width, height, tl, tr, br, bl, effInset, ma.dashFraction, ma.segLen]);

  // Directional motion blur: per-axis Gaussian sigma from the ring's center
  // velocity, clamped so a fast full-viewport travel smears without going soupy.
  // Attached only while actually moving (sigma > a quarter px on an axis) — a
  // settled ring carries no filter, keeping snapshot renders deterministic.
  let filterId: string | null = null;
  let sx = 0;
  let sy = 0;
  if (velocity) {
    sx = Math.min(fr.blurMaxPx, Math.abs(velocity.x) * fr.blurGain);
    sy = Math.min(fr.blurMaxPx, Math.abs(velocity.y) * fr.blurGain);
    if (sx > 0.25 || sy > 0.25) filterId = `selection-ring-blur-${rawId.replace(/:/g, '')}`;
  }

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}
    >
      {filterId && (
        // Region padded to ±50% so the blur isn't clipped at the path bounds.
        <filter id={filterId} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation={`${sx} ${sy}`} />
        </filter>
      )}
      {ghosts?.map((g, i) => (
        // Ghosts are always solid strokes (dashes on trailing copies look noisy),
        // fading by trailFalloff^(i+1) with the nearest ghost most opaque.
        <path
          key={i}
          transform={`translate(${g.dx} ${g.dy})`}
          d={roundedRectPath(g.width, g.height, g.tl, g.tr, g.br, g.bl, effInset)}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          opacity={Math.pow(fr.trailFalloff, i + 1)}
        />
      ))}
      <path
        ref={svgRef}
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeDasharray={dashStyle?.dasharray}
        filter={filterId ? `url(#${filterId})` : undefined}
        style={dashStyle ? {
          animation: `marching-ants ${ma.cycleDuration}s linear infinite`,
          animationPlayState: (ma.paused || paused) ? 'paused' : 'running',
          ['--march-offset' as string]: `-${dashStyle.offset}px`,
        } : undefined}
      />
    </svg>
  );
}
