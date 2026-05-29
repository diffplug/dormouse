import { describe, expect, it } from 'vitest';
import {
  SHIFT_ENTER_NEWLINE_INPUT,
  shiftEnterInputForEvent,
  shouldHandleWindowsShiftEnter,
} from './terminal-keyboard';

function keydown(init: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    altKey: false,
    ctrlKey: false,
    isComposing: false,
    key: 'Enter',
    metaKey: false,
    shiftKey: true,
    type: 'keydown',
    ...init,
  } as KeyboardEvent;
}

describe('terminal keyboard normalization', () => {
  it('uses LF for the Shift+Enter newline override', () => {
    expect(SHIFT_ENTER_NEWLINE_INPUT).toBe('\n');
  });

  it('matches plain Shift+Enter on Windows', () => {
    expect(shouldHandleWindowsShiftEnter(keydown(), { isWindows: true })).toBe(true);
  });

  it('uses LF for Shift+Enter on Windows', () => {
    expect(shiftEnterInputForEvent(keydown(), { isWindows: true }))
      .toBe(SHIFT_ENTER_NEWLINE_INPUT);
  });

  it('does not match normal Enter, composing input, or non-Windows platforms', () => {
    expect(shouldHandleWindowsShiftEnter(keydown({ shiftKey: false }), { isWindows: true })).toBe(false);
    expect(shouldHandleWindowsShiftEnter(keydown({ isComposing: true }), { isWindows: true })).toBe(false);
    expect(shouldHandleWindowsShiftEnter(keydown(), { isWindows: false })).toBe(false);
    expect(shiftEnterInputForEvent(keydown(), { isWindows: false })).toBe(null);
  });

  it('leaves modified Enter chords alone', () => {
    expect(shouldHandleWindowsShiftEnter(keydown({ ctrlKey: true }), { isWindows: true })).toBe(false);
    expect(shouldHandleWindowsShiftEnter(keydown({ altKey: true }), { isWindows: true })).toBe(false);
    expect(shouldHandleWindowsShiftEnter(keydown({ metaKey: true }), { isWindows: true })).toBe(false);
  });
});
