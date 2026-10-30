import { isEditableTarget, isTerminalInputProxy } from '../../../lib/dom';
import { isKillAnswerKey } from './handle-kill-confirm';
import { PANE_VERB_KEYS } from './handle-pane-shortcuts';
import type { WallKeyboardCtx } from './types';

/** Whether the focused element uses the key itself: a text field or select any
 *  key, a button-like control Space (Enter is a pane verb). xterm's input proxy
 *  is not one of ours, so a key on it stays a stray and never reaches the PTY. */
function usedByFocusedControl(e: KeyboardEvent): boolean {
  const target = e.target instanceof Element ? e.target : null;
  if (!target) return false;
  if ((isEditableTarget(target) && !isTerminalInputProxy(target)) || target.closest('select')) return true;
  return e.key === ' ' && target.closest('button, [role="button"], [role="checkbox"], [role="switch"], summary') !== null;
}

/** A key someone typing into a terminal would press: one printed character
 *  (Space included) or Backspace, with no modifier but Shift. A bound key is
 *  never a stray, even where its verb is inert (`t` on a Door), nor is a key the
 *  focused control uses. */
export function isStrayKey(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return false;
  if (PANE_VERB_KEYS.has(e.key) || usedByFocusedControl(e)) return false;
  return e.key === 'Backspace' || [...e.key].length === 1;
}

/** Last in the command-mode chain: a stray key the handlers above left
 *  unanswered raises the prompt instead of passing silently, so the rest of a
 *  word typed in the wrong mode cannot fire the verbs its letters spell. */
export function handleStrayKey(e: KeyboardEvent, ctx: WallKeyboardCtx): boolean {
  if (!isStrayKey(e)) return false;
  e.preventDefault();
  e.stopPropagation();
  ctx.raiseStrayKey(e.key);
  return true;
}

/** While the prompt shows it answers every key: Escape dismisses it, Enter
 *  dismisses it and falls through to the ordinary Enter, and every other answer
 *  key is swallowed. Modifiers and host chords pass as they do for the kill
 *  confirmation. */
export function handleStrayKeyPrompt(e: KeyboardEvent, ctx: WallKeyboardCtx): boolean {
  if (!ctx.strayKeyRef.current) return false;
  if (!isKillAnswerKey(e)) return true;
  if (e.key === 'Enter') {
    ctx.dismissStrayKey();
    return false;
  }
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') ctx.dismissStrayKey();
  return true;
}
