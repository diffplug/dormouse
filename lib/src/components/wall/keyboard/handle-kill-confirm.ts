import type { WallKeyboardCtx } from './types';

/**
 * Kill-confirmation second-key handler. Once a kill is staged in confirmKillRef,
 * we hijack every key: matching letter accepts, anything else rejects.
 */
export function handleKillConfirm(e: KeyboardEvent, ctx: WallKeyboardCtx): boolean {
  const ck = ctx.confirmKillRef.current;
  if (!ck) return false;

  e.preventDefault();
  e.stopPropagation();
  if (ck.exit) return true;

  if (e.key.toLowerCase() === ck.char.toLowerCase() && ctx.nav.ready()) {
    ctx.acceptKill();
    return true;
  }
  ctx.rejectKill();
  return true;
}
