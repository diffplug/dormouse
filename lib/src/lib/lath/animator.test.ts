import { describe, it, expect } from 'vitest';
import { createAnimator, cubicBezier, LATH_EASING, LATH_MOTION_MS } from './animator';
import type { Rect } from './model';

const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });
const A = rect(0, 0, 100, 100);
const B = rect(200, 50, 300, 400);

// A fixed clock: the animator takes `now` as an argument, so tests pass plain numbers.
const T0 = 1000;
const DUR = 400;

function make(durationMs = DUR) {
  return createAnimator({ durationMs, easing: LATH_EASING });
}

describe('cubicBezier', () => {
  it('is exact and monotone at the endpoints', () => {
    const e = cubicBezier(0.22, 1, 0.36, 1);
    expect(e(0)).toBe(0);
    expect(e(1)).toBe(1);
    expect(e(-5)).toBe(0);
    expect(e(5)).toBe(1);
  });

  it('is monotone increasing across the unit interval', () => {
    const e = LATH_EASING;
    let prev = -1;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const v = e(t);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
  });

  it('recovers x from the curve (solver correctness): linear bezier is identity', () => {
    const linear = cubicBezier(1 / 3, 1 / 3, 2 / 3, 2 / 3);
    expect(linear(0.25)).toBeCloseTo(0.25, 5);
    expect(linear(0.5)).toBeCloseTo(0.5, 5);
    expect(linear(0.8)).toBeCloseTo(0.8, 5);
  });

  it('house easing (0.22,1,0.36,1) leads its input (fast-out)', () => {
    expect(LATH_EASING(0.5)).toBeGreaterThan(0.5);
    expect(LATH_MOTION_MS).toBe(440);
  });
});

describe('animator retarget + framesAt', () => {
  it('appears instantly at the target when there is no enter hint', () => {
    const a = make();
    a.retarget(new Map([['x', B]]), T0);
    const f = a.framesAt(T0).get('x')!;
    expect(f.rect).toEqual(B);
    expect(f.opacity).toBe(1);
    expect(f.layer).toBe(0);
    expect(a.settledAt(T0)).toBe(true);
  });

  it('interpolates rect + opacity through the eased midpoint', () => {
    const a = make();
    // Seed at A (instant), then retarget to B.
    a.retarget(new Map([['x', A]]), T0);
    a.retarget(new Map([['x', B]]), T0);
    const mid = a.framesAt(T0 + DUR / 2).get('x')!;
    const e = LATH_EASING(0.5);
    expect(mid.rect.x).toBeCloseTo(A.x + (B.x - A.x) * e, 5);
    expect(mid.rect.width).toBeCloseTo(A.width + (B.width - A.width) * e, 5);
    expect(a.settledAt(T0 + DUR / 2)).toBe(false);
    // End.
    const end = a.framesAt(T0 + DUR).get('x')!;
    expect(end.rect).toEqual(B);
    expect(a.settledAt(T0 + DUR)).toBe(true);
  });

  it('retargets mid-flight FROM the current interpolated frame', () => {
    const a = make();
    a.retarget(new Map([['x', A]]), T0);
    a.retarget(new Map([['x', B]]), T0); // A → B
    const midFrame = a.framesAt(T0 + DUR / 2).get('x')!;
    const C = rect(-100, -100, 10, 10);
    a.retarget(new Map([['x', C]]), T0 + DUR / 2); // interrupt → new from = midFrame
    // Immediately after the interrupt, the frame equals where it was.
    const at = a.framesAt(T0 + DUR / 2).get('x')!;
    expect(at.rect.x).toBeCloseTo(midFrame.rect.x, 5);
    expect(at.rect.width).toBeCloseTo(midFrame.rect.width, 5);
    // ...and converges on C.
    const conv = a.framesAt(T0 + DUR / 2 + DUR).get('x')!.rect;
    expect(conv.x).toBeCloseTo(C.x, 6);
    expect(conv.y).toBeCloseTo(C.y, 6);
    expect(conv.width).toBeCloseTo(C.width, 6);
    expect(conv.height).toBeCloseTo(C.height, 6);
  });

  it('enters from each edge collapsed against that edge of the target', () => {
    const target = rect(100, 100, 200, 80);
    const check = (edge: 'left' | 'right' | 'top' | 'bottom' | 'top-left', expected: Rect) => {
      const a = make();
      a.retarget(new Map([['n', target]]), T0, new Map([['n', edge]]));
      const f0 = a.framesAt(T0).get('n')!;
      expect(f0.rect).toEqual(expected);
      expect(f0.opacity).toBe(0);
      expect(a.settledAt(T0)).toBe(false);
      // Grows to the full target.
      expect(a.framesAt(T0 + DUR).get('n')!.rect).toEqual(target);
      expect(a.framesAt(T0 + DUR).get('n')!.opacity).toBe(1);
    };
    check('left', rect(100, 100, 0, 80));
    check('right', rect(300, 100, 0, 80));
    check('top', rect(100, 100, 200, 0));
    check('bottom', rect(100, 180, 200, 0));
    check('top-left', rect(100, 100, 0, 0));
  });

  it('drops leaves absent from the new targets', () => {
    const a = make();
    a.retarget(new Map([['x', A], ['y', B]]), T0);
    a.retarget(new Map([['x', A]]), T0);
    const frames = a.framesAt(T0);
    expect(frames.has('x')).toBe(true);
    expect(frames.has('y')).toBe(false);
  });

  it('snap starts every leaf already at its target (no tween), even mid-flight', () => {
    const a = make();
    a.retarget(new Map([['x', A]]), T0);
    a.retarget(new Map([['x', B]]), T0); // tween A→B
    // Snap to C mid-flight.
    const C = rect(5, 5, 5, 5);
    a.retarget(new Map([['x', C]]), T0 + DUR / 2, undefined, { snap: true });
    expect(a.framesAt(T0 + DUR / 2).get('x')!.rect).toEqual(C);
    expect(a.settledAt(T0 + DUR / 2)).toBe(true);
  });
});

describe('animator markDying', () => {
  it('fades opacity → 0 over the duration with the rect frozen, layer 1', () => {
    const a = make();
    a.retarget(new Map([['x', A]]), T0);
    a.markDying('x', T0);
    expect(a.isDying('x')).toBe(true);
    const start = a.framesAt(T0).get('x')!;
    expect(start.opacity).toBe(1);
    expect(start.layer).toBe(1);
    expect(start.rect).toEqual(A); // frozen

    const mid = a.framesAt(T0 + DUR / 2).get('x')!;
    expect(mid.rect).toEqual(A); // still frozen
    expect(mid.opacity).toBeCloseTo(1 - LATH_EASING(0.5), 5);
    expect(a.settledAt(T0 + DUR / 2)).toBe(false);

    expect(a.framesAt(T0 + DUR).get('x')!.opacity).toBe(0);
    expect(a.settledAt(T0 + DUR)).toBe(true);
  });

  it('shrinks toward the bottom-right corner at zero size', () => {
    const a = make();
    a.retarget(new Map([['x', rect(10, 20, 100, 60)]]), T0);
    a.markDying('x', T0, { shrinkTowardBottomRight: true });
    const end = a.framesAt(T0 + DUR).get('x')!;
    expect(end.rect).toEqual(rect(110, 80, 0, 0)); // x+w, y+h, 0, 0
    expect(end.opacity).toBe(0);
  });

  it('is idempotent per id', () => {
    const a = make();
    a.retarget(new Map([['x', A]]), T0);
    a.markDying('x', T0);
    // A second markDying at a later time must NOT reset the fade timeline.
    a.markDying('x', T0 + 999, { shrinkTowardBottomRight: true });
    expect(a.framesAt(T0 + DUR).get('x')!.opacity).toBe(0); // finished on the ORIGINAL clock
    expect(a.framesAt(T0 + DUR).get('x')!.rect).toEqual(A); // still frozen, not shrunk
  });

  it('keeps a dying leaf dying across a retarget that still includes it, drops it once absent', () => {
    const a = make();
    a.retarget(new Map([['x', A], ['y', B]]), T0);
    a.markDying('x', T0);
    // A commit while x is still in the tree (e.g. another pane resized): x stays dying.
    a.retarget(new Map([['x', A], ['y', B]]), T0);
    expect(a.isDying('x')).toBe(true);
    expect(a.framesAt(T0).get('x')!.layer).toBe(1);
    // The remove commits: x is gone from the targets → dropped.
    a.retarget(new Map([['y', B]]), T0 + DUR);
    expect(a.isDying('x')).toBe(false);
    expect(a.framesAt(T0 + DUR).has('x')).toBe(false);
  });

  it('is a no-op for an unknown leaf', () => {
    const a = make();
    a.markDying('ghost', T0);
    expect(a.isDying('ghost')).toBe(false);
    expect(a.framesAt(T0).has('ghost')).toBe(false);
  });
});

describe('animator zero duration (reduced motion)', () => {
  it('snaps every transition instantly through the same code path', () => {
    const a = make(0);
    a.retarget(new Map([['x', A]]), T0, new Map([['x', 'left']])); // enter hint ignored — instant
    expect(a.framesAt(T0).get('x')!.rect).toEqual(A);
    expect(a.framesAt(T0).get('x')!.opacity).toBe(1);
    expect(a.settledAt(T0)).toBe(true);

    a.retarget(new Map([['x', B]]), T0);
    expect(a.framesAt(T0).get('x')!.rect).toEqual(B);
    expect(a.settledAt(T0)).toBe(true);

    a.markDying('x', T0);
    expect(a.framesAt(T0).get('x')!.opacity).toBe(0);
    expect(a.settledAt(T0)).toBe(true);
  });
});
