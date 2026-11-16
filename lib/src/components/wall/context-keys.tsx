import { createContext, useContext } from 'react';
import { Shortcut } from '../design';

/** The properties' control keys, live and labeled only while `ContextKeysContext` holds:
 *  a keyboard opening in command mode (`docs/specs/layout.md` → Header context menu). */
export const CONTEXT_KEYS = {
  copyId: 'i', explain: 'd', move: 'm', copyPath: 'c', explore: 'r', port: 'p',
  watch: 'w', todo: 't', aux: '!', keepOpen: 'k', back: '[', forward: ']', close: 'Escape',
  left: 'ArrowLeft', right: 'ArrowRight', top: 'ArrowUp', bottom: 'ArrowDown',
} as const;
/** The port row's launch actions, in row order, overflow included. */
export const PORT_ACTION_KEYS = ['1', '2', '3', '4', '5'] as const;

const GLYPH: Record<string, string> = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc' };
export const keyGlyph = (key: string) => GLYPH[key] ?? key;
/** The keys of the port actions from `from` to `to`, as one label. */
export const portKeyRange = (from: number, to: number) => (from < to ? `${PORT_ACTION_KEYS[from]}–${PORT_ACTION_KEYS[to]}` : PORT_ACTION_KEYS[from]);

/** Opens `select`'s list where the browser allows; focused, its own keys open it otherwise. */
export function openPicker(select: HTMLSelectElement) {
  try { select.showPicker(); } catch { /* not allowed or unsupported */ }
}

export const ContextKeysContext = createContext(false);

/** `key`'s label beside its control, while the keys are live. */
export function KeyHint({ k }: { k: string | undefined }) {
  return useContext(ContextKeysContext) && k ? <Shortcut className="font-normal">{keyGlyph(k)}</Shortcut> : null;
}

/** Marks the control `key` activates; the context finds it by this. */
export const contextKey = (key: string | undefined) => (key ? { 'data-context-key': key } : {});

/** Activates the control `key` names inside `root`, as a click or, for a select, by opening its list.
 *  A marked wrapper activates the control inside it. Returns whether a control answered. */
export function activateContextKey(root: HTMLElement, key: string): boolean {
  const marked = root.querySelector<HTMLElement>(`[data-context-key="${CSS.escape(key)}"]`);
  // An overflowed action is an option of its list: choosing it is the click.
  if (marked instanceof HTMLOptionElement) {
    const list = marked.parentElement;
    if (marked.disabled || !(list instanceof HTMLSelectElement) || list.getAttribute('aria-disabled') === 'true') return false;
    list.value = marked.value;
    list.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  const control = marked?.matches('button, select') ? marked : marked?.querySelector<HTMLElement>('button, select');
  if (!control || (control as HTMLButtonElement).disabled || control.getAttribute('aria-disabled') === 'true') return false;
  if (control instanceof HTMLSelectElement) {
    control.focus();
    openPicker(control);
  } else control.click();
  return true;
}
