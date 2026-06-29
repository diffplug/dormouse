/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleDualTap } from './handle-dual-tap';
import type { DualTapState, WallKeyboardCtx } from './types';

function makeCtx(mode: 'command' | 'passthrough' = 'passthrough'): {
  ctx: WallKeyboardCtx;
  exitTerminalMode: ReturnType<typeof vi.fn>;
} {
  const exitTerminalMode = vi.fn();
  const ctx = {
    modeRef: { current: mode },
    exitTerminalMode,
  } as unknown as WallKeyboardCtx;
  return { ctx, exitTerminalMode };
}

function makeState(): DualTapState {
  return {
    lastCmdSide: { current: null },
    lastCmdTime: { current: 0 },
    lastShiftSide: { current: null },
    lastShiftTime: { current: 0 },
  };
}

/** location 1 = left, 2 = right (DOM_KEY_LOCATION_{LEFT,RIGHT}). */
function keydown(key: string, location: number): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, location });
}

describe('handleDualTap', () => {
  let now = 0;

  beforeEach(() => {
    now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits passthrough on left-then-right Meta within 500ms', () => {
    const { ctx, exitTerminalMode } = makeCtx('passthrough');
    const state = makeState();

    expect(handleDualTap(keydown('Meta', 1), ctx, state)).toBe(true);
    expect(exitTerminalMode).not.toHaveBeenCalled();

    now += 200;
    expect(handleDualTap(keydown('Meta', 2), ctx, state)).toBe(true);
    expect(exitTerminalMode).toHaveBeenCalledTimes(1);
    // State resets after a completed gesture so the next press starts fresh.
    expect(state.lastCmdSide.current).toBeNull();
  });

  it('does not exit when the right press lands after the 500ms window', () => {
    const { ctx, exitTerminalMode } = makeCtx('passthrough');
    const state = makeState();

    handleDualTap(keydown('Meta', 1), ctx, state);
    now += 500; // boundary is exclusive (< 500), so 500ms is too late
    handleDualTap(keydown('Meta', 2), ctx, state);

    expect(exitTerminalMode).not.toHaveBeenCalled();
  });

  it('does not exit on right-then-left ordering', () => {
    const { ctx, exitTerminalMode } = makeCtx('passthrough');
    const state = makeState();

    handleDualTap(keydown('Meta', 2), ctx, state);
    now += 100;
    handleDualTap(keydown('Meta', 1), ctx, state);

    expect(exitTerminalMode).not.toHaveBeenCalled();
  });

  it('exits passthrough on left-then-right Shift, independently of Meta', () => {
    const { ctx, exitTerminalMode } = makeCtx('passthrough');
    const state = makeState();

    expect(handleDualTap(keydown('Shift', 1), ctx, state)).toBe(true);
    now += 100;
    expect(handleDualTap(keydown('Shift', 2), ctx, state)).toBe(true);

    expect(exitTerminalMode).toHaveBeenCalledTimes(1);
    expect(state.lastShiftSide.current).toBeNull();
  });

  it('does not cross-trigger between Meta and Shift', () => {
    const { ctx, exitTerminalMode } = makeCtx('passthrough');
    const state = makeState();

    // Left Meta then right Shift is not a completed gesture for either track.
    handleDualTap(keydown('Meta', 1), ctx, state);
    now += 100;
    handleDualTap(keydown('Shift', 2), ctx, state);

    expect(exitTerminalMode).not.toHaveBeenCalled();
  });

  it('consumes Meta and Shift but ignores other keys', () => {
    const { ctx } = makeCtx('passthrough');
    const state = makeState();

    expect(handleDualTap(keydown('Meta', 1), ctx, state)).toBe(true);
    expect(handleDualTap(keydown('Shift', 1), ctx, state)).toBe(true);
    expect(handleDualTap(keydown('a', 0), ctx, state)).toBe(false);
    expect(handleDualTap(keydown('Enter', 0), ctx, state)).toBe(false);
  });

  it('completes the gesture but does not call exit when already in command mode', () => {
    const { ctx, exitTerminalMode } = makeCtx('command');
    const state = makeState();

    handleDualTap(keydown('Meta', 1), ctx, state);
    now += 100;
    handleDualTap(keydown('Meta', 2), ctx, state);

    expect(exitTerminalMode).not.toHaveBeenCalled();
    // The gesture still resets its state even when the mode guard skips exit.
    expect(state.lastCmdSide.current).toBeNull();
  });
});
