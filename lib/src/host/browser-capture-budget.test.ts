// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCaptureBudget, type CaptureClaim } from './browser-capture-budget';

const claim = (urgent = false, wanted = () => true): CaptureClaim => ({ urgent, wanted });

/** A capture the test settles. */
function pending() {
  let settle!: (value: string) => void;
  const fn = vi.fn(() => new Promise<string>((resolve) => { settle = resolve; }));
  return { fn, settle: (value: string) => settle(value) };
}

describe('the capture budget', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('runs no more captures at once than its slots, the next as one ends', async () => {
    const budget = createCaptureBudget({ concurrent: 2, perSecond: 100 });
    const [a, b, c] = [pending(), pending(), pending()];
    const results = [budget.run(a.fn, claim()), budget.run(b.fn, claim()), budget.run(c.fn, claim())];
    expect([a.fn, b.fn, c.fn].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 0]);
    a.settle('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(c.fn).toHaveBeenCalledOnce();
    b.settle('b');
    c.settle('c');
    expect(await Promise.all(results)).toEqual(['a', 'b', 'c']);
  });

  it('starts no more than its rate in any second, across every pane', async () => {
    const budget = createCaptureBudget({ concurrent: 10, perSecond: 3 });
    const captures = Array.from({ length: 5 }, () => vi.fn(async () => 'shot'));
    for (const capture of captures) void budget.run(capture, claim());
    await vi.advanceTimersByTimeAsync(0);
    expect(captures.filter((capture) => capture.mock.calls.length > 0)).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(captures.filter((capture) => capture.mock.calls.length > 0)).toHaveLength(5);
  });

  it('serves the pane the user is interacting with first, then the rest in arrival order', async () => {
    const budget = createCaptureBudget({ concurrent: 1, perSecond: 100 });
    const first = pending();
    const order: string[] = [];
    void budget.run(first.fn, claim());
    for (const [name, urgent] of [['b', false], ['c', false], ['urgent', true]] as const) {
      void budget.run(async () => { order.push(name); }, claim(urgent));
    }
    first.settle('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['urgent', 'b', 'c']);
  });

  it('frees the slot of a capture that never settles, answering it undefined', async () => {
    const budget = createCaptureBudget({ concurrent: 1, perSecond: 100, timeoutMs: 5000 });
    const wedged = budget.run(() => new Promise<string>(() => {}), claim());
    const next = vi.fn(async () => 'next');
    const after = budget.run(next, claim());
    await vi.advanceTimersByTimeAsync(4999);
    expect(next).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await wedged).toBeUndefined();
    expect(await after).toBe('next');
  });

  it('drops a claim nobody wants any more without spending the budget on it', async () => {
    const budget = createCaptureBudget({ concurrent: 1, perSecond: 100 });
    const first = pending();
    void budget.run(first.fn, claim());
    let wanted = true;
    const abandoned = vi.fn(async () => 'x');
    const dropped = budget.run(abandoned, claim(false, () => wanted));
    wanted = false;
    first.settle('a');
    expect(await dropped).toBeUndefined();
    expect(abandoned).not.toHaveBeenCalled();
  });

  it('answers a failed capture undefined and moves on', async () => {
    const budget = createCaptureBudget({ concurrent: 1, perSecond: 100 });
    expect(await budget.run(async () => { throw new Error('gone'); }, claim())).toBeUndefined();
    expect(await budget.run(async () => 'ok', claim())).toBe('ok');
  });
});
