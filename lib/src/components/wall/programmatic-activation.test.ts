import { describe, expect, it } from 'vitest';
import { withProgrammaticActivation, type ProgrammaticActivationRef } from './programmatic-activation';

describe('withProgrammaticActivation', () => {
  it('returns the value the wrapped fn returns', () => {
    const ref: ProgrammaticActivationRef = { current: 0 };
    expect(withProgrammaticActivation(ref, () => 42)).toBe(42);
  });

  it('increments the depth during fn and restores it after', () => {
    const ref: ProgrammaticActivationRef = { current: 0 };
    let depthInside = -1;
    withProgrammaticActivation(ref, () => {
      depthInside = ref.current;
    });
    expect(depthInside).toBe(1);
    expect(ref.current).toBe(0);
  });

  it('keeps depth > 0 across nesting until the outermost exits', () => {
    const ref: ProgrammaticActivationRef = { current: 0 };
    const seen: number[] = [];
    withProgrammaticActivation(ref, () => {
      seen.push(ref.current);
      withProgrammaticActivation(ref, () => {
        seen.push(ref.current);
      });
      // Inner finally decremented, but the outer scope is still tagged.
      seen.push(ref.current);
    });
    expect(seen).toEqual([1, 2, 1]);
    expect(ref.current).toBe(0);
  });

  it('decrements even when fn throws, and rethrows', () => {
    const ref: ProgrammaticActivationRef = { current: 0 };
    const boom = new Error('boom');
    expect(() => withProgrammaticActivation(ref, () => { throw boom; })).toThrow(boom);
    expect(ref.current).toBe(0);
  });
});
