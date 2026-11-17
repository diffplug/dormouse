import { createContext, useContext } from 'react';
import { Shortcut } from '../design';

/** The properties' control keys, live and labeled only while `ContextKeysContext` holds:
 *  a keyboard opening in command mode (`docs/specs/layout.md` → Header context menu). */
export const CONTEXT_KEYS = {
  copyId: 's', move: 'w', copyPath: 'c', explore: 'r', port: 'p', more: '+',
  watch: 'a', todo: 't', aux: '!', keepOpen: 'k', back: '[', forward: ']', close: 'Escape',
  left: 'ArrowLeft', right: 'ArrowRight', top: 'ArrowUp', bottom: 'ArrowDown',
} as const;
/** The port row's launch actions, in row order; overflowed ones answer once `more` shows them. */
export const PORT_ACTION_KEYS = ['1', '2', '3', '4', '5'] as const;

const GLYPH: Record<string, string> = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc' };

export const ContextKeysContext = createContext(false);

/** `key`'s label after its control's face, while the keys are live. */
export function KeyHint({ k }: { k: string | undefined }) {
  return useContext(ContextKeysContext) && k ? <Shortcut className="font-normal">{GLYPH[k] ?? k}</Shortcut> : null;
}

/** `text`, its first `k` bracketed in place while the keys are live (`[s]urface:1`), else the key after it.
 *  One span, so a flex parent's gap never splits the word. */
export function Mnemonic({ text, k }: { text: string; k: string }) {
  const live = useContext(ContextKeysContext);
  const at = live ? text.toLowerCase().indexOf(k.toLowerCase()) : -1;
  if (at < 0) return <span className="whitespace-nowrap">{text}<KeyHint k={k} /></span>;
  return <span className="whitespace-nowrap">{text.slice(0, at)}<Shortcut className="font-normal">{text[at]}</Shortcut>{text.slice(at + 1)}</span>;
}

/** Marks the control `key` activates; the context finds it by this. */
export const contextKey = (key: string | undefined) => (key ? { 'data-context-key': key } : {});

/** Opens `select`'s list where the browser allows; focused, its own keys open it otherwise. */
export function openPicker(select: HTMLSelectElement) {
  try { select.showPicker(); } catch { /* not allowed or unsupported */ }
}

/** Activates the control `key` names inside `root`, as a click or, for a select, by opening its list.
 *  A marked wrapper activates the control inside it. Returns whether a control answered. */
export function activateContextKey(root: HTMLElement, key: string): boolean {
  const marked = root.querySelector<HTMLElement>(`[data-context-key="${CSS.escape(key)}"]`);
  const control = marked?.matches('button, select') ? marked : marked?.querySelector<HTMLElement>('button, select');
  if (!control || (control as HTMLButtonElement).disabled || control.getAttribute('aria-disabled') === 'true') return false;
  if (control instanceof HTMLSelectElement) {
    control.focus();
    openPicker(control);
  } else control.click();
  return true;
}
