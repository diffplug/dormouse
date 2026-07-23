import { useLayoutEffect, useRef, useState } from 'react';
import { cfg } from '../../cfg';
import { PANE_SELECTION_RING_RADIUS_PX, TERMINAL_BORDER_RADIUS_PX } from '../design';

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

export function MarchingAntsRect({ width, height, isDoor, color, paused }: {
  width: number;
  height: number;
  isDoor: boolean;
  color: string;
  paused?: boolean;
}) {
  const svgRef = useRef<SVGPathElement>(null);
  const [dashStyle, setDashStyle] = useState<{ dasharray: string; offset: number } | null>(null);
  const ma = cfg.marchingAnts;

  // Concentric-corners rule (design.tsx): the pane ring's rect is inflated by
  // SELECTION_RING_INFLATE_PX, so its edge radius is the pane radius plus that
  // offset; the door ring draws on the door rect itself and keeps the pane
  // radius. roundedRectPath then shrinks by `inset` so the stroke CENTERLINE
  // stays concentric with the wrapped corner.
  const r = isDoor ? TERMINAL_BORDER_RADIUS_PX : PANE_SELECTION_RING_RADIUS_PX;
  const br = isDoor ? 0 : r;
  const bl = isDoor ? 0 : r;
  const inset = ma.strokeWidth / 2;

  const d = roundedRectPath(width, height, r, r, br, bl, inset);

  useLayoutEffect(() => {
    const path = svgRef.current;
    if (!path) return;
    const len = path.getTotalLength();
    const count = Math.max(1, Math.round(len / ma.segLen));
    const adjusted = len / count;
    const dash = adjusted * ma.dashFraction;
    const gap = adjusted * (1 - ma.dashFraction);
    setDashStyle({ dasharray: `${dash} ${gap}`, offset: adjusted });
  }, [width, height, isDoor, ma.dashFraction, ma.segLen]);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}
    >
      <path
        ref={svgRef}
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={ma.strokeWidth}
        strokeDasharray={dashStyle?.dasharray}
        style={dashStyle ? {
          animation: `marching-ants ${ma.cycleDuration}s linear infinite`,
          animationPlayState: (ma.paused || paused) ? 'paused' : 'running',
          ['--march-offset' as string]: `-${dashStyle.offset}px`,
        } : undefined}
      />
    </svg>
  );
}
