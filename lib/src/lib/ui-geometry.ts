import type { CSSProperties } from 'react';
import { cfg } from '../cfg';

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

/** The layout-coordinate bounds fixed overlays can actually occupy. Mobile
 *  browser chrome and the on-screen keyboard may shrink and offset these while
 *  the layout viewport is unchanged. */
export function overlayViewportBounds() {
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  const width = viewport?.width ?? window.innerWidth;
  const height = viewport?.height ?? window.innerHeight;
  return { left, top, right: left + width, bottom: top + height, width, height };
}

/** Call `listener` whenever `overlayViewportBounds()` may have changed: the
 *  window's resize, and the visual viewport's resize and scroll, which carries
 *  origin changes that resize neither. Returns the unsubscribe. */
export function subscribeOverlayViewport(listener: () => void): () => void {
  const controller = new AbortController();
  const { signal } = controller;
  window.addEventListener('resize', listener, { signal });
  window.visualViewport?.addEventListener('resize', listener, { signal });
  window.visualViewport?.addEventListener('scroll', listener, { signal });
  return () => controller.abort();
}

/** Clamp a fixed-position overlay so it stays inside the viewport with a margin. */
export function clampOverlayPosition({ left, top, width, height }: {
  left: number;
  top: number;
  width: number;
  height: number;
}): CSSProperties {
  const margin = OVERLAY_VIEWPORT_MARGIN_PX;
  const viewport = overlayViewportBounds();
  const minLeft = viewport.left + margin;
  const minTop = viewport.top + margin;
  const maxLeft = Math.max(minLeft, viewport.right - width - margin);
  const maxTop = Math.max(minTop, viewport.bottom - height - margin);

  return {
    position: 'fixed',
    left: Math.min(Math.max(left, minLeft), maxLeft),
    top: Math.min(Math.max(top, minTop), maxTop),
  };
}
