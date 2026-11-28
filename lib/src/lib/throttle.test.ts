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

    // 28 calls, 16ms apart, across 440ms.
    for (let t = 0; t < 440; t += 16) {
      throttled();
      vi.advanceTimersByTime(16);
    }
    // Leading (t=0) + intermediates roughly every 150ms while the burst runs.
    const duringBurst = fn.mock.calls.length;
    expect(duringBurst).toBeGreaterThanOrEqual(2);
    expect(duringBurst).toBeLessThanOrEqual(5);

    // The last call left a trailing fire pending: exactly one more lands.
    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(duringBurst + 1);
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
