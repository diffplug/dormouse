import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { throttleTrailing } from './throttle';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('throttleTrailing', () => {
  it('fires immediately for a single call (leading edge) and never again', () => {
    const fn = vi.fn();
    const throttled = throttleTrailing(fn, 150);

    throttled();
    expect(fn).toHaveBeenCalledTimes(1);

    // No further calls arrive — the window closes with nothing pending.
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst into leading + capped intermediates + trailing', () => {
    const fn = vi.fn();
    const throttled = throttleTrailing(fn, 150);

    // Simulate ~26 animation frames (16ms apart) across a 440ms motion.
    for (let t = 0; t < 440; t += 16) {
      throttled();
      vi.advanceTimersByTime(16);
    }
    // Leading (t=0) + intermediates roughly every 150ms while the burst runs.
    // Far fewer than 27 raw frames; a small handful.
    const duringBurst = fn.mock.calls.length;
    expect(duringBurst).toBeGreaterThanOrEqual(2);
    expect(duringBurst).toBeLessThanOrEqual(5);

    // Let everything settle — a final trailing call fits the resting geometry.
    vi.advanceTimersByTime(300);
    const total = fn.mock.calls.length;
    expect(total).toBeGreaterThan(duringBurst - 1);
    expect(total).toBeLessThanOrEqual(5);
  });

  it('fires a trailing call after a leading + one interior call', () => {
    const fn = vi.fn();
    const throttled = throttleTrailing(fn, 150);

    throttled(); // leading, fires now
    expect(fn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(50);
    throttled(); // inside window — trailing pending, not yet fired
    expect(fn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(100); // window (150ms) closes → trailing fires
    expect(fn).toHaveBeenCalledTimes(2);

    // Nothing else pending — no extra fire.
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('cancel() drops a pending trailing call', () => {
    const fn = vi.fn();
    const throttled = throttleTrailing(fn, 150);

    throttled(); // leading fires
    throttled(); // trailing pending
    expect(fn).toHaveBeenCalledTimes(1);

    throttled.cancel();
    vi.advanceTimersByTime(1000);
    // Trailing was cancelled — still just the one leading call.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('leads again after the window fully closes', () => {
    const fn = vi.fn();
    const throttled = throttleTrailing(fn, 150);

    throttled();
    expect(fn).toHaveBeenCalledTimes(1);

    // Let the window close with nothing pending.
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);

    // A later call is a fresh leading edge, immediate again.
    throttled();
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
