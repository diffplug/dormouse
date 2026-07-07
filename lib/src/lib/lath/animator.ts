// Lath animator: the headless motion core (docs/specs/tiling-engine.md → "Animation
// contract"). Turns committed layout changes into presentation frames as a *pure
// function of time* — no DOM, React, timers, or Date/performance. Time always comes
// in as a `now` argument, so every renderer animates identically and tests assert
// real interpolated values against a fake clock. The HTML adapter (LathHost) drives
// it from a rAF loop; a Three.js adapter would drive it from its render loop.

import { rectsClose, type Edge, type Rect } from './model';

/** A presentation frame for one leaf at a given instant. `layer` is a discrete band
 *  the adapter maps to z-index (0 = tiled, 1 = dying/on-top); it is never interpolated. */
export type Frame = { rect: Rect; opacity: number; layer: number };

/** Where an entering leaf's frames begin: collapsed against one `Edge` of its target
 *  (zero extent along that edge's axis), or `'top-left'` (both dims zero at the
 *  target's top-left — the auto-spawn refill). */
export type EnterFrom = Edge | 'top-left';

/** House motion, matched to the pre-Lath CSS constants. */
export const LATH_MOTION_MS = 440;

/** Cubic-bezier easing solver: `(x1,y1)`/`(x2,y2)` are the two control points of a
 *  curve from `(0,0)` to `(1,1)`. Returns a `t → eased` progress mapping (Newton–
 *  Raphson with a bisection fallback), exact at the endpoints. Exported for tests. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  // Polynomial coefficients of the cubic bezier in each axis (P0 = 0, P3 = 1).
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (s: number): number => ((ax * s + bx) * s + cx) * s;
  const sampleY = (s: number): number => ((ay * s + by) * s + cy) * s;
  const sampleDX = (s: number): number => (3 * ax * s + 2 * bx) * s + cx;

  const solveX = (x: number): number => {
    // Newton–Raphson from x as the initial guess.
    let s = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(s) - x;
      if (Math.abs(err) < 1e-6) return s;
      const d = sampleDX(s);
      if (Math.abs(d) < 1e-6) break;
      s -= err / d;
    }
    // Bisection fallback (guaranteed to converge on the monotone x mapping).
    let lo = 0;
    let hi = 1;
    s = x;
    for (let i = 0; i < 32; i++) {
      const err = sampleX(s) - x;
      if (Math.abs(err) < 1e-6) return s;
      if (err > 0) hi = s;
      else lo = s;
      s = (lo + hi) / 2;
    }
    return s;
  };

  return (t: number): number => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return sampleY(solveX(t));
  };
}

/** The house easing (`cubic-bezier(0.22, 1, 0.36, 1)`), solved in JS to match the
 *  pre-Lath CSS transitions. */
export const LATH_EASING = cubicBezier(0.22, 1, 0.36, 1);

export interface LathAnimator {
  /** Ingest a committed layout. Every existing (non-dying) leaf retargets FROM its
   *  current interpolated frame at `now` (interruptible by construction). A leaf new
   *  to the animator starts from `enters.get(id)` when provided — its rect collapsed
   *  against that edge of the target with opacity 0 — else it appears instantly at
   *  its target. A leaf currently dying is left dying if still in `targets`, dropped
   *  otherwise. Leaves absent from `targets` (and not dying) are dropped immediately.
   *  `opts.snap` starts every leaf already at its target (no tween) — used when the
   *  user placed the geometry by hand (sash-drag commit) or on a container resize. */
  retarget(
    targets: ReadonlyMap<string, Rect>,
    now: number,
    enters?: ReadonlyMap<string, EnterFrom>,
    opts?: { snap?: boolean },
  ): void;
  /** Exit phase 1: freeze the leaf's rect (or, with `shrinkTowardBottomRight`, tween
   *  it toward its own bottom-right corner at zero size — the last-pane kill) and fade
   *  opacity → 0 over the duration, `layer` 1. The leaf stays tracked until the next
   *  `retarget` that omits it (the caller commits `remove` when the fade completes).
   *  Idempotent per id; a no-op for an unknown leaf. */
  markDying(id: string, now: number, opts?: { shrinkTowardBottomRight?: boolean }): void;
  /** Whether `id` is mid-exit. */
  isDying(id: string): boolean;
  /** Interpolated presentation frames — a pure function of `now`. */
  framesAt(now: number): Map<string, Frame>;
  /** True when nothing is mid-flight at `now` (adapters stop ticking). */
  settledAt(now: number): boolean;
}

/** One leaf's motion segment: interpolate `from → to` over `[start, start+duration]`. */
type Segment = { from: Frame; to: Frame; start: number };

/** The entering rect: collapsed against `edge` of `to` (zero extent along that axis),
 *  so the leaf grows from that boundary. `'top-left'` collapses both dims. */
function collapsedRect(to: Rect, edge: EnterFrom): Rect {
  switch (edge) {
    case 'left':
      return { x: to.x, y: to.y, width: 0, height: to.height };
    case 'right':
      return { x: to.x + to.width, y: to.y, width: 0, height: to.height };
    case 'top':
      return { x: to.x, y: to.y, width: to.width, height: 0 };
    case 'bottom':
      return { x: to.x, y: to.y + to.height, width: to.width, height: 0 };
    case 'top-left':
      return { x: to.x, y: to.y, width: 0, height: 0 };
  }
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function lerpFrame(from: Frame, to: Frame, t: number): Frame {
  return {
    rect: {
      x: lerp(from.rect.x, to.rect.x, t),
      y: lerp(from.rect.y, to.rect.y, t),
      width: lerp(from.rect.width, to.rect.width, t),
      height: lerp(from.rect.height, to.rect.height, t),
    },
    opacity: lerp(from.opacity, to.opacity, t),
    // `layer` is discrete: it never interpolates. `from` and `to` always agree, so
    // either works; take `to`.
    layer: to.layer,
  };
}

/** Whether two frames are close enough to treat as "no visual change" (so the
 *  segment can start already-settled, keeping `settledAt` honest). */
function framesClose(a: Frame, b: Frame): boolean {
  return rectsClose(a.rect, b.rect, 0.01) && Math.abs(a.opacity - b.opacity) < 0.01;
}

export function createAnimator(opts: { durationMs: number; easing?: (t: number) => number }): LathAnimator {
  const duration = opts.durationMs;
  const easing = opts.easing ?? LATH_EASING;

  // Live (tiled/entering) segments and exiting (dying) segments. A leaf is in at most
  // one map at a time; `markDying` moves it from `anims` to `dying`.
  let anims = new Map<string, Segment>();
  const dying = new Map<string, Segment>();

  const sample = (seg: Segment, now: number): Frame => {
    const raw = duration <= 0 ? 1 : (now - seg.start) / duration;
    const clamped = raw < 0 ? 0 : raw > 1 ? 1 : raw;
    return lerpFrame(seg.from, seg.to, easing(clamped));
  };

  const framesAt = (now: number): Map<string, Frame> => {
    const out = new Map<string, Frame>();
    for (const [id, seg] of anims) out.set(id, sample(seg, now));
    for (const [id, seg] of dying) out.set(id, sample(seg, now));
    return out;
  };

  return {
    retarget(targets, now, enters, retargetOpts) {
      const snap = retargetOpts?.snap ?? false;
      // Snapshot current frames BEFORE mutating so each retarget starts from the
      // leaf's present position (interruptible by construction).
      const current = framesAt(now);
      const next = new Map<string, Segment>();

      for (const [id, toRect] of targets) {
        // A dying leaf still in the tree stays dying (frozen/shrinking); do not
        // resurrect it into a tiled tween.
        if (dying.has(id)) continue;

        const to: Frame = { rect: toRect, opacity: 1, layer: 0 };
        let from: Frame;
        if (snap) {
          from = to;
        } else if (anims.has(id)) {
          from = current.get(id) ?? to;
        } else {
          const enter = enters?.get(id);
          from = enter ? { rect: collapsedRect(toRect, enter), opacity: 0, layer: 0 } : to;
        }
        // Unchanged (or snapped) leaves start already-settled so `settledAt` and the
        // adapter's tick loop don't spin on frames that never move.
        const start = snap || framesClose(from, to) ? now - duration : now;
        next.set(id, { from, to, start });
      }

      // Drop dying leaves the tree no longer contains (their fade already ran). A Map
      // tolerates deletion during its own key iteration, so no snapshot is needed.
      for (const id of dying.keys()) {
        if (!targets.has(id)) dying.delete(id);
      }
      anims = next;
    },

    markDying(id, now, dyingOpts) {
      if (dying.has(id)) return; // idempotent
      // Sample this leaf's own live segment directly (it is not dying, per the guard
      // above) instead of building the whole frame map just to read one entry.
      const seg = anims.get(id);
      if (!seg) return; // unknown leaf — nothing to fade
      const cur = sample(seg, now);
      const fromRect = cur.rect;
      const toRect = dyingOpts?.shrinkTowardBottomRight
        ? { x: fromRect.x + fromRect.width, y: fromRect.y + fromRect.height, width: 0, height: 0 }
        : fromRect;
      dying.set(id, {
        from: { rect: fromRect, opacity: cur.opacity, layer: 1 },
        to: { rect: toRect, opacity: 0, layer: 1 },
        start: now,
      });
      anims.delete(id);
    },

    isDying: (id) => dying.has(id),

    framesAt,

    settledAt(now) {
      for (const seg of anims.values()) if (now < seg.start + duration) return false;
      for (const seg of dying.values()) if (now < seg.start + duration) return false;
      return true;
    },
  };
}
