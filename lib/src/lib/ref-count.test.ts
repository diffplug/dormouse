import { describe, expect, it, vi } from 'vitest';
import { createRefCount } from './ref-count';

describe('createRefCount', () => {
  it('arms on the first holder and disarms on the last', () => {
    const disarm = vi.fn();
    const onFirst = vi.fn(() => disarm);
    const acquire = createRefCount({ onFirst });

    const a = acquire();
    const b = acquire();
    expect(onFirst).toHaveBeenCalledTimes(1);

    a();
    expect(disarm).not.toHaveBeenCalled();
    b();
    expect(disarm).toHaveBeenCalledTimes(1);

    // Armed again from zero, with a fresh disarm.
    acquire();
    expect(onFirst).toHaveBeenCalledTimes(2);
  });

  it('ignores a repeated release, so a double teardown cannot strand the resource', () => {
    const disarm = vi.fn();
    const acquire = createRefCount({ onFirst: () => disarm });

    const a = acquire();
    const b = acquire();
    a();
    a();
    a();
    expect(disarm).not.toHaveBeenCalled();
    // The count is still 1, not -1: the last real holder disarms it.
    b();
    expect(disarm).toHaveBeenCalledTimes(1);
  });

  it('reports a holder joining or leaving an already-armed resource, and no other edge', () => {
    const counts: number[] = [];
    const acquire = createRefCount({ onFirst: () => () => {}, onChange: (count) => counts.push(count) });

    const a = acquire();
    expect(counts).toEqual([]); // arming is not a change
    const b = acquire();
    const c = acquire();
    expect(counts).toEqual([2, 3]);
    c();
    b();
    expect(counts).toEqual([2, 3, 2, 1]);
    a();
    expect(counts).toEqual([2, 3, 2, 1]); // disarming is not a change either
  });

  it('accepts an onFirst that arms nothing to undo', () => {
    const acquire = createRefCount({ onFirst: () => {} });
    const release = acquire();
    expect(() => { release(); release(); }).not.toThrow();
  });
});
