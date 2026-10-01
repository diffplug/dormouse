import { describe, expect, it } from 'vitest';
import { wrapRun } from './buffer-cells';

/** Rows by name, each row in `wrapped` a soft wrap continuing the one before. */
const rowsOf = (names: readonly string[], wrapped: readonly number[]) => ({
  length: names.length,
  getLine: (r: number) => (names[r] === undefined ? undefined : { name: names[r], isWrapped: wrapped.includes(r) }),
});
const run = (buffer: ReturnType<typeof rowsOf>, r: number, reach?: number) => {
  const { top, lines } = wrapRun(buffer, r, reach);
  return { top, names: lines.map((l) => l.name) };
};

describe('wrapRun', () => {
  const buffer = rowsOf(['a', 'b0', 'b1', 'b2', 'c'], [2, 3]);

  it('reads the rows soft wraps join, from any of them', () => {
    for (const r of [1, 2, 3]) expect(run(buffer, r)).toEqual({ top: 1, names: ['b0', 'b1', 'b2'] });
    expect(run(buffer, 0)).toEqual({ top: 0, names: ['a'] });
    expect(run(buffer, 4)).toEqual({ top: 4, names: ['c'] });
  });

  it('reaches at most `reach` rows either side', () => {
    expect(run(buffer, 2, 0)).toEqual({ top: 2, names: ['b1'] });
    expect(run(buffer, 3, 1)).toEqual({ top: 2, names: ['b1', 'b2'] });
    expect(run(buffer, 1, 1)).toEqual({ top: 1, names: ['b0', 'b1'] });
  });

  it('stops at the buffer edges', () => {
    // Trimmed scrollback can leave the first row a continuation.
    expect(run(rowsOf(['x1', 'x2'], [0, 1]), 1)).toEqual({ top: 0, names: ['x1', 'x2'] });
    expect(run(buffer, 5)).toEqual({ top: 5, names: [] });
    expect(run(buffer, -1)).toEqual({ top: -1, names: [] });
  });
});
