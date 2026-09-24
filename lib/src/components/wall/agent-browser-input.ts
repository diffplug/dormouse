/**
 * Pure keyboard/mouse → agent-browser stream-input translation. Kept out of the
 * panel so the mapping (especially the windows-virtual-key table, which has a
 * nasty `.`=VK_DELETE footgun) is independently testable.
 */

// `text` is what makes typing land; windowsVirtualKeyCode is what makes
// non-text keys and modifier chords act. Keyed by KeyboardEvent.key.
export const SPECIAL_KEYS: Record<string, { text?: string; keyCode: number }> = {
  Enter: { text: '\r', keyCode: 13 },
  Tab: { text: '\t', keyCode: 9 },
  Backspace: { text: '\b', keyCode: 8 },
  Escape: { keyCode: 27 },
  ArrowLeft: { keyCode: 37 },
  ArrowUp: { keyCode: 38 },
  ArrowRight: { keyCode: 39 },
  ArrowDown: { keyCode: 40 },
  Delete: { keyCode: 46 },
  Insert: { keyCode: 45 },
  Home: { keyCode: 36 },
  End: { keyCode: 35 },
  PageUp: { keyCode: 33 },
  PageDown: { keyCode: 34 },
  Shift: { keyCode: 16 },
  Control: { keyCode: 17 },
  Alt: { keyCode: 18 },
  Meta: { keyCode: 91 },
  CapsLock: { keyCode: 20 },
  ContextMenu: { keyCode: 93 },
};

// Windows virtual-key codes for printable keys, keyed by KeyboardEvent.code
// (the physical key, so shifted variants share an entry). Letters and digits
// are handled structurally in virtualKeyCode. Never derive a VK from
// `key.charCodeAt(0)`: '.' is 46, which is VK_DELETE — the daemon deletes
// instead of typing a period.
export const OEM_VK_BY_CODE: Record<string, number> = {
  Space: 32,
  Semicolon: 186,
  Equal: 187,
  Comma: 188,
  Minus: 189,
  Period: 190,
  Slash: 191,
  Backquote: 192,
  BracketLeft: 219,
  Backslash: 220,
  BracketRight: 221,
  Quote: 222,
  NumpadDecimal: 110,
  NumpadDivide: 111,
  NumpadMultiply: 106,
  NumpadSubtract: 109,
  NumpadAdd: 107,
};

export function virtualKeyCode(key: string, code: string): number {
  const special = SPECIAL_KEYS[key];
  if (special) return special.keyCode;
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^(Digit|Numpad)[0-9]$/.test(code)) return code.charCodeAt(code.length - 1) + (code.startsWith('Numpad') ? 48 : 0);
  if (/^F([1-9]|1[0-2])$/.test(code)) return 111 + Number(code.slice(1));
  return OEM_VK_BY_CODE[code] ?? 0;
}

// Cmd/Ctrl + these map to native editing ops the stream input path can't do.
export const EDIT_OPS = { a: 'selectAll', c: 'copy', x: 'cut' } as const;

export const MOUSE_BUTTONS: Record<number, string> = { 0: 'left', 1: 'middle', 2: 'right' };
export const MOUSE_BUTTON_MASKS: Record<number, number> = { 0: 1, 1: 4, 2: 2 };

export function modifiers(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}
