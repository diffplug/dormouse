/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { handleDualTap } from './handle-dual-tap';
import type { WallKeyboardCtx } from './types';

function makeCtx(mode: 'command' | 'passthrough'): {
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

function keydown(key: string): KeyboardEvent {
  return new KeyboardEvent('keydown', { key });
}

describe('handleDualTap', () => {
  it('exits passthrough on a completed gesture', () => {
    const { ctx, exitTerminalMode } = makeCtx('passthrough');
    expect(handleDualTap(keydown('Meta'), ctx, false)).toBe(true);
    expect(exitTerminalMode).not.toHaveBeenCalled();
    expect(handleDualTap(keydown('Meta'), ctx, true)).toBe(true);
    expect(exitTerminalMode).toHaveBeenCalledTimes(1);
  });

  it('consumes Meta and Shift but ignores other keys', () => {
    const { ctx } = makeCtx('passthrough');
    expect(handleDualTap(keydown('Meta'), ctx, false)).toBe(true);
    expect(handleDualTap(keydown('Shift'), ctx, false)).toBe(true);
    expect(handleDualTap(keydown('a'), ctx, false)).toBe(false);
    expect(handleDualTap(keydown('Enter'), ctx, false)).toBe(false);
  });

  it('does not call exit when already in command mode', () => {
    const { ctx, exitTerminalMode } = makeCtx('command');
    expect(handleDualTap(keydown('Meta'), ctx, true)).toBe(true);
    expect(exitTerminalMode).not.toHaveBeenCalled();
  });
});
