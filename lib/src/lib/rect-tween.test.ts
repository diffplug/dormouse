import { describe, expect, it } from 'vitest';
import { LATH_EASING } from './lath/animator';
import {
  retargetRingTween,
  sampleRingTween,
  startRingTween,
  type RingFrame,
} from './rect-tween';

const PANE_SHAPE = { tl: 12, tr: 12, br: 12, bl: 12, inset: 0.5 };
const DOOR_SHAPE = { tl: 8, tr: 8, br: 0, bl: 0, inset: 1 };

const A: RingFrame = { rect: { top: 0, left: 0, width: 100, height: 40 }, shape: PANE_SHAPE };
const B: RingFrame = { rect: { top: 200, left: 300, width: 160, height: 60 }, shape: PANE_SHAPE };

const DUR = 220;

describe('rect-tween', () => {
  it('is exact at both endpoints', () => {
    const tween = startRingTween(A, B, 0, DUR);
    const atStart = sampleRingTween(tween, 0);
    expect(atStart.rect).toEqual(A.rect);
    expect(atStart.shape).toEqual(A.shape);
    expect(atStart.done).toBe(false);

    const atEnd = sampleRingTween(tween, DUR);
    expect(atEnd.rect).toEqual(B.rect);
    expect(atEnd.shape).toEqual(B.shape);
    expect(atEnd.done).toBe(true);

    // Sampling before the start clamps to `from`; past the end clamps to `to`.
    expect(sampleRingTween(tween, -50).rect).toEqual(A.rect);
    expect(sampleRingTween(tween, DUR + 50).rect).toEqual(B.rect);
    expect(sampleRingTween(tween, DUR + 50).done).toBe(true);
  });

  it('eases the midpoint on the house curve, not linearly', () => {
    const tween = startRingTween(A, B, 0, DUR);
    const mid = sampleRingTween(tween, DUR / 2);
    const e = LATH_EASING(0.5);
    // House ease-out is well past halfway at the temporal midpoint.
    expect(e).toBeGreaterThan(0.5);
    expect(mid.rect.top).toBeCloseTo(0 + (200 - 0) * e, 6);
    expect(mid.rect.left).toBeCloseTo(0 + (300 - 0) * e, 6);
    expect(mid.rect.width).toBeCloseTo(100 + (160 - 100) * e, 6);
    expect(mid.rect.height).toBeCloseTo(40 + (60 - 40) * e, 6);
  });

  it('retarget keeps the same clock and completion, and lands on the new target', () => {
    const tween = startRingTween(A, B, 0, DUR);
    // A third of the way in, the destination moves to C.
    const C: RingFrame = { rect: { top: 500, left: 20, width: 90, height: 30 }, shape: PANE_SHAPE };
    const retargeted = retargetRingTween(tween, C);

    // Same start clock and duration → same completion instant, and the origin
    // `from` is preserved (converges on the moving target rather than restarting).
    expect(retargeted.start).toBe(tween.start);
    expect(retargeted.durationMs).toBe(tween.durationMs);
    expect(retargeted.from).toEqual(A);

    // Lands exactly on C at the original completion instant.
    const atEnd = sampleRingTween(retargeted, DUR);
    expect(atEnd.rect).toEqual(C.rect);
    expect(atEnd.done).toBe(true);
    // Just before completion it is not yet done.
    expect(sampleRingTween(retargeted, DUR - 1).done).toBe(false);
  });

  it('retargeting to the unchanged target leaves the trajectory identical', () => {
    const tween = startRingTween(A, B, 0, DUR);
    const same = retargetRingTween(tween, B);
    for (const t of [0, 40, 110, 180, DUR]) {
      expect(sampleRingTween(same, t)).toEqual(sampleRingTween(tween, t));
    }
  });

  it('startRingTween restarts the clock from the current interpolated frame', () => {
    const tween = startRingTween(A, B, 0, DUR);
    const mid = sampleRingTween(tween, DUR / 2);
    // Identity changed mid-glide: restart from where the ring currently sits.
    const restarted = startRingTween({ rect: mid.rect, shape: mid.shape }, A, DUR / 2, DUR);
    expect(restarted.start).toBe(DUR / 2);
    // Progress 0 at the new start → exactly the current frame.
    expect(sampleRingTween(restarted, DUR / 2).rect).toEqual(mid.rect);
    // Full duration later it has arrived at the new target.
    expect(sampleRingTween(restarted, DUR / 2 + DUR).rect).toEqual(A.rect);
  });

  it('zero (or negative) duration snaps straight to the target', () => {
    const snap = startRingTween(A, B, 1_000, 0);
    const s = sampleRingTween(snap, 1_000);
    expect(s.rect).toEqual(B.rect);
    expect(s.shape).toEqual(B.shape);
    expect(s.done).toBe(true);
    // Even sampling "before" the start reads as done at the target.
    expect(sampleRingTween(snap, 0).done).toBe(true);
    expect(sampleRingTween(startRingTween(A, B, 0, -10), 0).rect).toEqual(B.rect);
  });

  it('morphs pane↔door shape by lerping every radius and the inset', () => {
    const pane: RingFrame = { rect: A.rect, shape: PANE_SHAPE };
    const door: RingFrame = { rect: B.rect, shape: DOOR_SHAPE };
    const tween = startRingTween(pane, door, 0, DUR);
    const e = LATH_EASING(0.5);
    const mid = sampleRingTween(tween, DUR / 2);
    expect(mid.shape.tl).toBeCloseTo(12 + (8 - 12) * e, 6);
    expect(mid.shape.br).toBeCloseTo(12 + (0 - 12) * e, 6);
    expect(mid.shape.bl).toBeCloseTo(12 + (0 - 12) * e, 6);
    expect(mid.shape.inset).toBeCloseTo(0.5 + (1 - 0.5) * e, 6);
    // Endpoints remain exact door geometry.
    expect(sampleRingTween(tween, DUR).shape).toEqual(DOOR_SHAPE);
  });
});
