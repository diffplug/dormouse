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

/** Perpendicular speed of each ring edge while it travels (px/ms). See
 *  `sampleRingVelocity` for why the four are independent. */
export interface RingEdgeSpeeds {
  top: number;
  right: number;
  bottom: number;
  left: number;
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

/** Raw (unclamped) progress through the tween, plus the `[0,1]` value the easing
 *  is evaluated at. Position and velocity MUST read the clock the same way or the
 *  smear desynchronizes from the ring it describes, so both go through here. A
 *  zero-duration tween reads as already complete. */
function progressAt(tween: RingTween, now: number): { raw: number; clamped: number } {
  const raw = tween.durationMs <= 0 ? 1 : (now - tween.start) / tween.durationMs;
  return { raw, clamped: raw < 0 ? 0 : raw > 1 ? 1 : raw };
}

/** Sample the tween at `now`, eased by `LATH_EASING`. Exact at both endpoints
 *  (`LATH_EASING` returns 0/1 at the bounds, so the lerp resolves to `from`/`to`
 *  identically); a zero-duration tween reads as done at `to`. `done` flips true
 *  once the clock reaches the completion instant. */
export function sampleRingTween(tween: RingTween, now: number): { rect: RingRect; shape: RingShape; done: boolean } {
  const { clamped } = progressAt(tween, now);
  const eased = LATH_EASING(clamped);
  return {
    rect: lerpRect(tween.from.rect, tween.to.rect, eased),
    shape: lerpShape(tween.from.shape, tween.to.shape, eased),
    done: clamped >= 1,
  };
}

/**
 * Each edge's perpendicular speed at `now`, in px/ms — the exact derivative of
 * `sampleRingTween`, not a difference of two samples.
 *
 * The rect is a plain lerp of `from → to` under `LATH_EASING`, so every edge's
 * position is `from + (to - from) * E(t)` and its speed falls straight out as
 * `|to - from| * E'(t) / durationMs`. Only the component ACROSS each edge counts
 * (a horizontal edge is moved by `top`/`bottom`, a vertical one by `left`/
 * `right`); motion along an edge slides it along its own length and smears
 * nothing.
 *
 * Analytic rather than finite-differenced on purpose. Differencing successive
 * frames costs a frame of lag, reports nothing at all on the first frame (there
 * is no previous sample yet), and under-reports a decelerating curve because a
 * backward difference averages over the interval. On a 220ms ease-out whose
 * velocity peaks at 4.5x its average at `t = 0`, those three losses land exactly
 * where the smear should be strongest. This is also jitter-free by construction:
 * it never differences wall-clock timestamps, so it needs no smoothing.
 */
export function sampleRingVelocity(tween: RingTween, now: number): RingEdgeSpeeds {
  const { raw, clamped } = progressAt(tween, now);
  // At or past the completion instant the ring is parked. `slope` already clamps
  // its own argument, so this exists only to force an exact zero — a settled ring
  // must never carry a smear, and the curve's slope merely approaches 0.
  const rate = raw >= 1 ? 0 : LATH_EASING.slope(clamped) / tween.durationMs;
  const from = tween.from.rect;
  const to = tween.to.rect;
  const edge = (a: number, b: number) => Math.abs(b - a) * rate;
  return {
    top: edge(from.top, to.top),
    bottom: edge(from.top + from.height, to.top + to.height),
    left: edge(from.left, to.left),
    right: edge(from.left + from.width, to.left + to.width),
  };
}
