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
 *  settled. Drives the directional motion-blur filter. */
export interface RingVelocity {
  x: number;
  y: number;
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
// `velocity` drives the directional motion blur; it is null on a settled ring, so
// a resting or reduced-motion render is always clean (no filter).
export function SelectionRing({
  variant, width, height, tl, tr, br, bl, inset, color, paused, velocity,
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
        // sRGB interpolation (not the filter default linearRGB) keeps the blurred
        // smear the ring's true color/brightness instead of muddying it.
        <filter id={filterId} x="-50%" y="-50%" width="200%" height="200%" colorInterpolationFilters="sRGB">
          <feGaussianBlur stdDeviation={`${sx} ${sy}`} />
        </filter>
      )}
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
