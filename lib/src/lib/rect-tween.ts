// Focus-ring tween core — the selection ring's travel between panes/doors as a
// pure function of time (animator style: `now` is always passed in; no DOM,
// React, timers, or Date/performance). The overlay drives it from a rAF loop and
// tests assert real interpolated values against a fake clock, exactly like the
// Lath animator (lib/src/lib/lath/animator.ts). It reuses that module's house
// easing rather than re-deriving the curve.

import { LATH_EASING } from './lath/animator';

/** The ring's measured box in viewport (fixed-position) coordinates. */
export interface RingRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** The ring's corner radii + stroke inset. Carried alongside the rect so a
 *  pane↔door selection morphs its shape (radii lerp) instead of popping. */
export interface RingShape {
  tl: number;
  tr: number;
  br: number;
  bl: number;
  inset: number;
}

/** One measured presentation frame of the ring: where it sits and what shape. */
export interface RingFrame {
  rect: RingRect;
  shape: RingShape;
}

/** A ring motion segment: interpolate `from → to` over `[start, start+durationMs]`,
 *  eased by the house curve. The same shape as the Lath animator's `Segment`,
 *  minus the DOM. */
export interface RingTween {
  from: RingFrame;
  to: RingFrame;
  start: number;
  durationMs: number;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function lerpRect(from: RingRect, to: RingRect, t: number): RingRect {
  return {
    top: lerp(from.top, to.top, t),
    left: lerp(from.left, to.left, t),
    width: lerp(from.width, to.width, t),
    height: lerp(from.height, to.height, t),
  };
}

function lerpShape(from: RingShape, to: RingShape, t: number): RingShape {
  return {
    tl: lerp(from.tl, to.tl, t),
    tr: lerp(from.tr, to.tr, t),
    br: lerp(from.br, to.br, t),
    bl: lerp(from.bl, to.bl, t),
    inset: lerp(from.inset, to.inset, t),
  };
}

/** Begin a fresh tween from `current` toward `to`, clock starting at `now`. Used
 *  when the selected identity changes — the ring restarts its glide from wherever
 *  it currently sits, so arrow-key spam stays responsive. A zero (or negative)
 *  duration yields a tween that samples as already-complete at `to`. */
export function startRingTween(current: RingFrame, to: RingFrame, now: number, durationMs: number): RingTween {
  return { from: current, to, start: now, durationMs };
}

/** Retarget an in-flight tween to a new destination WITHOUT resetting its clock
 *  (same start, same completion instant). The origin `from` is deliberately kept:
 *  when the target moves smoothly under the tween (a survivor the Lath animator is
 *  growing during a kill), sampling advances by small amounts on both progress and
 *  destination, so the path stays smooth and still lands exactly on the final `to`
 *  at the original completion instant — the ring converges on the moving target
 *  instead of restarting each frame. */
export function retargetRingTween(tween: RingTween, to: RingFrame): RingTween {
  return { from: tween.from, to, start: tween.start, durationMs: tween.durationMs };
}

/** Sample the tween at `now`, eased by `LATH_EASING`. Exact at both endpoints
 *  (`LATH_EASING` returns 0/1 at the bounds, so the lerp resolves to `from`/`to`
 *  identically); a zero-duration tween reads as done at `to`. `done` flips true
 *  once the clock reaches the completion instant. */
export function sampleRingTween(tween: RingTween, now: number): { rect: RingRect; shape: RingShape; done: boolean } {
  const raw = tween.durationMs <= 0 ? 1 : (now - tween.start) / tween.durationMs;
  const clamped = raw < 0 ? 0 : raw > 1 ? 1 : raw;
  const eased = LATH_EASING(clamped);
  return {
    rect: lerpRect(tween.from.rect, tween.to.rect, eased),
    shape: lerpShape(tween.from.shape, tween.to.shape, eased),
    done: clamped >= 1,
  };
}
