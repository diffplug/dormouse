import type { DualTapState, WallKeyboardCtx } from './types';

/**
 * Detects left-then-right Meta or Shift within 500 ms and exits passthrough.
 * Always consumes Meta/Shift presses (returns true) so later handlers don't
 * misinterpret a bare modifier press as a navigation key.
 */
export function handleDualTap(
  e: KeyboardEvent,
  ctx: WallKeyboardCtx,
  state: DualTapState,
): boolean {
  if (e.key === 'Meta') {
    detect(e, state.lastCmdSide, state.lastCmdTime, ctx);
    return true;
  }
  if (e.key === 'Shift') {
    detect(e, state.lastShiftSide, state.lastShiftTime, ctx);
    return true;
  }
  return false;
}

function detect(
  e: KeyboardEvent,
  lastSide: { current: 'left' | 'right' | null },
  lastTime: { current: number },
  ctx: WallKeyboardCtx,
): void {
  const now = Date.now();
  const side = e.location === 1 ? 'left' : 'right';
  if (
    lastSide.current === 'left' &&
    side === 'right' &&
    now - lastTime.current < 500
  ) {
    if (ctx.modeRef.current === 'passthrough') ctx.exitTerminalMode();
    lastSide.current = null;
    return;
  }
  lastSide.current = side;
  lastTime.current = now;
}
