/**
 * The modes a fresh terminal reports, for the fake owners, handles, and attach
 * results remote tests and stories build. Test-only, and free of any test
 * framework so stories can load it.
 */

import type { IModes } from '@xterm/xterm';
import type { TerminalModes } from 'remote-lib-common';

export const FRESH_TERMINAL_MODES: TerminalModes = Object.freeze({
  applicationCursorKeys: false,
  applicationKeypad: false,
  bracketedPaste: false,
  insert: false,
  origin: false,
  reverseWraparound: false,
  wraparound: true,
  showCursor: true,
  sendFocus: false,
  mouseTracking: 'none',
  mouseEncoding: 'default',
  win32Input: false,
  colorSchemeUpdates: false,
  cursorStyle: 'default',
  cursorBlink: false,
  alternateScreen: false,
  kittyKeyboard: Object.freeze({ main: [], alternate: [] }),
});

/** What a fake owner's terminal needs for `readTerminalModes` to read it as
 * fresh: xterm's public modes and its active screen. */
export const FRESH_XTERM_MODES: { modes: IModes; buffer: { active: { type: 'normal' | 'alternate' } } } = Object.freeze({
  modes: Object.freeze({
    applicationCursorKeysMode: false,
    applicationKeypadMode: false,
    bracketedPasteMode: false,
    insertMode: false,
    mouseTrackingMode: 'none',
    originMode: false,
    reverseWraparoundMode: false,
    sendFocusMode: false,
    showCursor: true,
    synchronizedOutputMode: false,
    win32InputMode: false,
    wraparoundMode: true,
  }),
  buffer: Object.freeze({ active: Object.freeze({ type: 'normal' }) }),
});
