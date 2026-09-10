import type { WallKeyboardCtx } from './types';

/**
 * Whether a key accepts a staged kill confirmation: a case-insensitive match of
 * the confirm letter, so Caps Lock still confirms. Every other key rejects, which
 * is why the confirmation hijacks each key it sees rather than testing for one.
 * Shared with the Workspace strip's own confirmation, which listens outside every
 * Wall (`docs/specs/shortcuts.md` → "Dialogs, menus & prompts").
 */
export function acceptsKillChar(key: string, char: string): boolean {
  return key.toLowerCase() === char.toLowerCase();
}

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

  if (acceptsKillChar(e.key, ck.char)) {
    ctx.acceptKill();
    return true;
  }
  ctx.rejectKill();
  return true;
}
