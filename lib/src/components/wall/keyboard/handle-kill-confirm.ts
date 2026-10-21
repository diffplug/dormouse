import type { WallKeyboardCtx } from './types';

/**
 * Whether a key accepts a staged kill confirmation: a case-insensitive match of
 * the confirm letter, so Caps Lock still confirms. Every other answer key rejects, which
 * is why the confirmation hijacks each key it sees rather than testing for one.
 * Shared with `WorkspaceKillConfirm`, which listens outside every
 * Wall (`docs/specs/shortcuts.md` → "Dialogs, menus & prompts").
 */
export function acceptsKillChar(key: string, char: string): boolean {
  return key.toLowerCase() === char.toLowerCase();
}

/** Modifiers and host chords never answer a typed-letter confirmation. Shift
 *  may produce an uppercase letter, which acceptsKillChar handles normally. */
export function isKillAnswerKey(event: KeyboardEvent): boolean {
  return !event.metaKey && !event.ctrlKey && !event.altKey
    && !['Shift', 'Meta', 'Control', 'Alt'].includes(event.key);
}

/**
 * Kill-confirmation second-key handler. Once a kill is staged in confirmKillRef,
 * we hijack answer keys: matching letter accepts, anything else rejects.
 */
export function handleKillConfirm(e: KeyboardEvent, ctx: WallKeyboardCtx): boolean {
  const ck = ctx.confirmKillRef.current;
  if (!ck) return false;
  if (!isKillAnswerKey(e)) return true;

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
