/**
 * @vitest-environment jsdom
 *
 * The copy editor's travel against a fake clock and rAF: frames run only when
 * a test advances them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cfg } from '../cfg';
import { LATH_EASING } from '../lib/lath/animator';
import type { RingRect } from '../lib/rect-tween';
import { FOCUS_MOTION_MS } from './design';
import { installFakeFrames } from './motion-test-utils';
import { createRectMotion } from './rect-motion';

const frames = installFakeFrames();
const frame = (ms: number) => frames.advance(ms);
let previousAnimate: boolean;

beforeEach(() => {
  previousAnimate = cfg.layout.animate;
  cfg.layout.animate = true;
});

afterEach(() => {
  cfg.layout.animate = previousAnimate;
});

const A: RingRect = { top: 0, left: 0, width: 100, height: 40 };
const B: RingRect = { top: 200, left: 300, width: 160, height: 60 };
const C: RingRect = { top: 500, left: 20, width: 90, height: 30 };

const lerp = (from: RingRect, to: RingRect, t: number): RingRect => {
  const e = LATH_EASING(t);
  return {
    top: from.top + (to.top - from.top) * e,
    left: from.left + (to.left - from.left) * e,
    width: from.width + (to.width - from.width) * e,
    height: from.height + (to.height - from.height) * e,
  };
};

/** A motion whose writes and visibility land in one log, in order. */
function motion() {
  const writes: RingRect[] = [];
  const log: (RingRect | 'shown' | 'hidden')[] = [];
  const m = createRectMotion({
    write: (r) => { writes.push(r); log.push(r); },
    show: (visible) => log.push(visible ? 'shown' : 'hidden'),
  });
  return { m, writes, log, last: () => writes[writes.length - 1] };
}

describe('createRectMotion', () => {
  it('snaps the first target and eases later ones from the displayed rect', () => {
    const { m, writes, last } = motion();
    m.setTarget(A);
    expect(writes).toEqual([A]);
    expect(frames.pending).toBe(0);
    m.setTarget(B);
    expect(writes).toHaveLength(1);
    frame(16);
    expect(last()).toEqual(lerp(A, B, 16 / FOCUS_MOTION_MS));
    frame(FOCUS_MOTION_MS);
    expect(last()).toEqual(B);
    expect(frames.pending).toBe(0);
  });

  it('continues a mid-flight change from the displayed rect, on a fresh clock', () => {
    const { m, last } = motion();
    m.setTarget(A);
    m.setTarget(B);
    frame(100);
    const shown = last();
    m.setTarget(C);
    frame(0);
    expect(last()).toEqual(shown);
    frame(16);
    expect(last()).toEqual(lerp(shown, C, 16 / FOCUS_MOTION_MS));
    // The old tween would have landed by now; the new one has not.
    frame(FOCUS_MOTION_MS - 100);
    expect(last()).not.toEqual(C);
    frame(100);
    expect(last()).toEqual(C);
  });

  it('ignores an equal target rather than restarting the tween', () => {
    const { m, last } = motion();
    m.setTarget(A);
    m.setTarget(B);
    frame(50);
    m.setTarget({ ...B });
    frame(16);
    expect(last()).toEqual(lerp(A, B, 66 / FOCUS_MOTION_MS));
  });

  it('rounds to whole pixels when it settles', () => {
    const { m, last } = motion();
    m.setTarget({ top: 10.4, left: 20.6, width: 300.5, height: 99.2 });
    expect(last()).toEqual({ top: 10, left: 21, width: 301, height: 99 });
    m.setTarget({ top: 50.3, left: 20.6, width: 300.5, height: 99.2 });
    frame(16);
    expect(Number.isInteger(last().top)).toBe(false);
    frame(FOCUS_MOTION_MS);
    expect(last()).toEqual({ top: 50, left: 21, width: 301, height: 99 });
  });

  it('snaps every target while motion is instant, cancelling a tween in flight', () => {
    const { m, writes, last } = motion();
    m.setTarget(A);
    m.setTarget(B);
    expect(frames.pending).toBe(1);
    cfg.layout.animate = false;
    m.setTarget(C);
    expect(last()).toEqual(C);
    expect(frames.pending).toBe(0);
    m.setTarget(A);
    expect(writes).toEqual([A, C, A]);
  });

  it('shows on its first frame and hides once, snapping the first target after', () => {
    const { m, log } = motion();
    const visibility = () => log.filter((entry) => typeof entry === 'string');
    m.setTarget(A);
    expect(log).toEqual([A, 'shown']);
    m.setTarget(B);
    frame(16);
    frame(FOCUS_MOTION_MS);
    expect(visibility()).toEqual(['shown']);
    m.hide();
    m.hide();
    expect(visibility()).toEqual(['shown', 'hidden']);
    expect(frames.pending).toBe(0);
    // The same target as before hiding shows again, snapped there.
    m.setTarget(B);
    expect(log.slice(-2)).toEqual([B, 'shown']);
    expect(frames.pending).toBe(0);
  });
});
