type KeyboardEventLike = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'isComposing' | 'key' | 'metaKey' | 'shiftKey' | 'type'
>;

export const SHIFT_ENTER_NEWLINE_INPUT = '\n';
export const BRACKETED_PASTE_NEWLINE_INPUT = '\x1b[200~\n\x1b[201~';

export function shouldHandleWindowsShiftEnter(
  event: KeyboardEventLike,
  options: { isWindows: boolean },
): boolean {
  return shiftEnterInputForEvent(event, { ...options, bracketedPasteMode: false }) !== null;
}

export function shiftEnterInputForEvent(
  event: KeyboardEventLike,
  options: { isWindows: boolean; bracketedPasteMode: boolean },
): string | null {
  if (!options.isWindows) return null;
  if (event.type !== 'keydown') return null;
  if (event.isComposing) return null;
  if (event.key !== 'Enter') return null;
  if (!event.shiftKey) return null;
  if (event.ctrlKey || event.altKey || event.metaKey) return null;
  return options.bracketedPasteMode ? BRACKETED_PASTE_NEWLINE_INPUT : SHIFT_ENTER_NEWLINE_INPUT;
}
