import { describe, expect, it } from 'vitest';
import {
  BRACKETED_PASTE_NEWLINE_INPUT,
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

  it('uses bracketed paste for Shift+Enter when the foreground app enabled bracketed paste', () => {
    expect(shiftEnterInputForEvent(keydown(), { isWindows: true, bracketedPasteMode: true }))
      .toBe(BRACKETED_PASTE_NEWLINE_INPUT);
  });

  it('falls back to LF when bracketed paste is not enabled', () => {
    expect(shiftEnterInputForEvent(keydown(), { isWindows: true, bracketedPasteMode: false }))
      .toBe(SHIFT_ENTER_NEWLINE_INPUT);
  });

  it('does not match normal Enter, composing input, or non-Windows platforms', () => {
    expect(shouldHandleWindowsShiftEnter(keydown({ shiftKey: false }), { isWindows: true })).toBe(false);
    expect(shouldHandleWindowsShiftEnter(keydown({ isComposing: true }), { isWindows: true })).toBe(false);
    expect(shouldHandleWindowsShiftEnter(keydown(), { isWindows: false })).toBe(false);
    expect(shiftEnterInputForEvent(keydown(), { isWindows: false, bracketedPasteMode: true })).toBe(null);
  });

  it('leaves modified Enter chords alone', () => {
    expect(shouldHandleWindowsShiftEnter(keydown({ ctrlKey: true }), { isWindows: true })).toBe(false);
    expect(shouldHandleWindowsShiftEnter(keydown({ altKey: true }), { isWindows: true })).toBe(false);
    expect(shouldHandleWindowsShiftEnter(keydown({ metaKey: true }), { isWindows: true })).toBe(false);
  });
});
