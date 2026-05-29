type KeyboardEventLike = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'isComposing' | 'key' | 'metaKey' | 'shiftKey' | 'type'
>;

export const SHIFT_ENTER_NEWLINE_INPUT = '\n';

export function shouldHandleWindowsShiftEnter(
  event: KeyboardEventLike,
  options: { isWindows: boolean },
): boolean {
  return shiftEnterInputForEvent(event, options) !== null;
}

export function shiftEnterInputForEvent(
  event: KeyboardEventLike,
  options: { isWindows: boolean },
): string | null {
  if (!options.isWindows) return null;
  if (event.type !== 'keydown') return null;
  if (event.isComposing) return null;
  if (event.key !== 'Enter') return null;
  if (!event.shiftKey) return null;
  if (event.ctrlKey || event.altKey || event.metaKey) return null;
  return SHIFT_ENTER_NEWLINE_INPUT;
}
