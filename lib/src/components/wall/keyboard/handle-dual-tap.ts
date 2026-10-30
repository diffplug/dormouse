import type { WallKeyboardCtx } from './types';

/**
 * Exits passthrough when `leader` (from `dualTap`) completed the gesture.
 * Always consumes Meta/Shift presses (returns true) so later handlers don't
 * misinterpret a bare modifier press as a navigation key.
 */
export function handleDualTap(
  e: KeyboardEvent,
  ctx: WallKeyboardCtx,
  leader: boolean,
): boolean {
  if (e.key !== 'Meta' && e.key !== 'Shift') return false;
  if (leader && ctx.modeRef.current === 'passthrough') ctx.exitTerminalMode();
  return true;
}
