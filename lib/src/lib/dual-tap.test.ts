import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dualTap, newDualTapState } from './dual-tap';

/** [key, location, ms since the previous key]; location 1 = left, 2 = right. */
type Press = [string, number, number];

// The iframe shim runs the function from its source text, so it must work with
// nothing but the built-ins in scope.
const fromSource = runInNewContext(`(${dualTap})`, { Date }) as typeof dualTap;

describe.each([
  ['dualTap', dualTap],
  ['dualTap from its source', fromSource],
])('%s', (_, tap) => {
  let now = 0;
  beforeEach(() => {
    now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function leaders(presses: Press[]): number {
    const state = newDualTapState();
    let count = 0;
    for (const [key, location, ms] of presses) {
      now += ms;
      if (tap(state, { key, location })) count++;
    }
    return count;
  }

  it.each<[string, Press[], number]>([
    ['left-then-right Meta', [['Meta', 1, 0], ['Meta', 2, 200]], 1],
    ['left-then-right Shift', [['Shift', 1, 0], ['Shift', 2, 100]], 1],
    ['the right press at 500ms (exclusive)', [['Meta', 1, 0], ['Meta', 2, 500]], 0],
    ['right-then-left', [['Meta', 2, 0], ['Meta', 1, 100]], 0],
    ['left Meta then right Shift', [['Meta', 1, 0], ['Shift', 2, 100]], 0],
    ['the other modifier between the taps', [['Shift', 1, 0], ['Meta', 1, 50], ['Shift', 2, 50]], 0],
    ['"I Am": another key between the taps', [['Shift', 1, 0], ['I', 0, 50], [' ', 0, 50], ['Shift', 2, 50]], 0],
    ['a third right press after a completed gesture', [['Meta', 1, 0], ['Meta', 2, 100], ['Meta', 2, 100]], 1],
  ])('%s → %i leader', (_, presses, want) => {
    expect(leaders(presses)).toBe(want);
  });
});
