import type { CSSProperties } from 'react';
import { cfg } from '../cfg';

/** Even-odd cross-product test for a convex polygon. Vertices may run in either winding order. */
export function pointInConvexPolygon(
  x: number,
  y: number,
  vertices: Array<{ x: number; y: number }>,
): boolean {
  let sign = 0;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (cross === 0) continue;
    if (sign === 0) sign = cross > 0 ? 1 : -1;
    else if ((cross > 0 ? 1 : -1) !== sign) return false;
  }
  return true;
}

/** True if the user has requested reduced motion (or we're in SSR). */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** True when chrome motion must resolve instantly: layout animation is disabled
 *  (Chromatic) or the user prefers reduced motion. The single snap gate shared
 *  by the Lath animator's duration and the focus ring's travel. */
export function motionIsInstant(): boolean {
  return !cfg.layout.animate || prefersReducedMotion();
}

/** Shared inset for fixed overlays clamped to the viewport. */
export const OVERLAY_VIEWPORT_MARGIN_PX = 12;

/** Clamp a fixed-position overlay so it stays inside the viewport with a margin. */
export function clampOverlayPosition({ left, top, width, height }: {
  left: number;
  top: number;
  width: number;
  height: number;
}): CSSProperties {
  const margin = OVERLAY_VIEWPORT_MARGIN_PX;
  const maxLeft = Math.max(margin, window.innerWidth - width - margin);
  const maxTop = Math.max(margin, window.innerHeight - height - margin);

  return {
    position: 'fixed',
    left: Math.min(Math.max(left, margin), maxLeft),
    top: Math.min(Math.max(top, margin), maxTop),
  };
}
