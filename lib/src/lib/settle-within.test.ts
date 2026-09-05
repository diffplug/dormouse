import { afterEach, describe, expect, it, vi } from 'vitest';
import { settleAllWithin } from './settle-within';

describe('settleAllWithin', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('falls back only for the entries that miss the deadline', async () => {
    vi.useFakeTimers();

    const settled = settleAllWithin<string>(
      [Promise.resolve('here'), new Promise<string>(() => {}), Promise.resolve('also here')],
      1000,
      'missing',
    );
    await vi.advanceTimersByTimeAsync(1000);

    await expect(settled).resolves.toEqual(['here', 'missing', 'also here']);
  });

  it('falls back for a rejection without failing the batch', async () => {
    await expect(settleAllWithin<string | null>(
      [Promise.reject(new Error('the PTY is gone')), Promise.resolve('kept')],
      1000,
      null,
    )).resolves.toEqual([null, 'kept']);
  });

  it('arms one timer for the whole batch and clears it once they settle', async () => {
    const armed = vi.spyOn(globalThis, 'setTimeout');
    const cleared = vi.spyOn(globalThis, 'clearTimeout');

    await expect(settleAllWithin(
      [Promise.resolve(1), Promise.resolve(2), Promise.resolve(3)],
      60_000,
      0,
    )).resolves.toEqual([1, 2, 3]);

    expect(armed).toHaveBeenCalledTimes(1);
    expect(cleared).toHaveBeenCalledTimes(1);
  });

  it('arms no timer at all for an empty batch', async () => {
    const armed = vi.spyOn(globalThis, 'setTimeout');

    await expect(settleAllWithin<string | null>([], 1000, null)).resolves.toEqual([]);

    expect(armed).not.toHaveBeenCalled();
  });
});
