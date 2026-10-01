/**
 * @vitest-environment jsdom
 *
 * The copy editor's travel against the fake clock and rAF of
 * WorkspaceSelectionOverlay.test.tsx: performance.now reads `clock`, and frames
 * run only when a test flushes them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cfg } from '../cfg';
import { LATH_EASING } from '../lib/lath/animator';
import type { RingRect } from '../lib/rect-tween';
import { FOCUS_MOTION_MS } from './design';
import { createRectMotion } from './rect-motion';

let clock = 0;
let rafSeq = 0;
let rafCbs: Map<number, FrameRequestCallback>;
let realNow: () => number;
let realRaf: typeof requestAnimationFrame;
let realCaf: typeof cancelAnimationFrame;
let previousAnimate: boolean;

/** Advance the clock and run the frames queued as of now. */
function frame(ms: number): void {
  clock += ms;
  const cbs = [...rafCbs.values()];
  rafCbs.clear();
  for (const cb of cbs) cb(clock);
}

beforeEach(() => {
  clock = 0;
  rafSeq = 0;
  rafCbs = new Map();
  realNow = performance.now.bind(performance);
  realRaf = globalThis.requestAnimationFrame;
  realCaf = globalThis.cancelAnimationFrame;
  performance.now = () => clock;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    const id = ++rafSeq;
    rafCbs.set(id, cb);
    return id;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => { rafCbs.delete(id); }) as typeof cancelAnimationFrame;
  globalThis.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  })) as unknown as typeof matchMedia;
  previousAnimate = cfg.layout.animate;
  cfg.layout.animate = true;
});

afterEach(() => {
  performance.now = realNow;
  globalThis.requestAnimationFrame = realRaf;
  globalThis.cancelAnimationFrame = realCaf;
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

function motion(options: Partial<Parameters<typeof createRectMotion>[0]> = {}) {
  const writes: RingRect[] = [];
  const m = createRectMotion({ write: (r) => writes.push(r), ...options });
  return { m, writes, last: () => writes[writes.length - 1] };
}

describe('createRectMotion', () => {
  it('snaps the first target and eases later ones from the displayed rect', () => {
    const { m, writes, last } = motion();
    m.setTarget(A);
    expect(writes).toEqual([A]);
    expect(rafCbs.size).toBe(0);
    m.setTarget(B);
    expect(writes).toHaveLength(1);
    frame(16);
    expect(last()).toEqual(lerp(A, B, 16 / FOCUS_MOTION_MS));
    frame(FOCUS_MOTION_MS);
    expect(last()).toEqual(B);
    expect(rafCbs.size).toBe(0);
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
    expect(rafCbs.size).toBe(1);
    cfg.layout.animate = false;
    m.setTarget(C);
    expect(last()).toEqual(C);
    expect(rafCbs.size).toBe(0);
    m.setTarget(A);
    expect(writes).toEqual([A, C, A]);
  });

  it('snaps the first target after hide', () => {
    const { m, writes, last } = motion();
    m.setTarget(A);
    m.setTarget(B);
    m.hide();
    expect(rafCbs.size).toBe(0);
    // The same target as before hiding still shows, and snaps there.
    m.setTarget(B);
    expect(last()).toEqual(B);
    expect(writes).toEqual([A, B]);
    expect(rafCbs.size).toBe(0);
  });

  it('cancels its frame on dispose and writes nothing after', () => {
    const { m, writes } = motion();
    m.setTarget(A);
    m.setTarget(B);
    m.dispose();
    expect(rafCbs.size).toBe(0);
    m.setTarget(C);
    frame(FOCUS_MOTION_MS);
    expect(writes).toEqual([A]);
  });

  it('uses the injected clock, frame scheduler and duration', () => {
    let own = 1000;
    let handles = 0;
    const frames: FrameRequestCallback[] = [];
    const cancelled: number[] = [];
    const { m, last } = motion({
      now: () => own,
      raf: (cb) => { frames.push(cb); return ++handles; },
      caf: (handle) => { cancelled.push(handle); },
      durationMs: 100,
    });
    m.setTarget(A);
    m.setTarget(B);
    expect(rafCbs.size).toBe(0);
    own += 50;
    frames.shift()!(own);
    expect(last()).toEqual(lerp(A, B, 0.5));
    own += 50;
    frames.shift()!(own);
    expect(last()).toEqual(B);
    // The third frame requested is the one dispose cancels.
    m.setTarget(C);
    m.dispose();
    expect(cancelled).toEqual([3]);
  });
});
