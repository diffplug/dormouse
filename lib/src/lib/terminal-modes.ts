import type { Terminal } from '@xterm/xterm';
import type { TerminalModes } from 'remote-lib-common';
import { ESC } from './ansi';
import { REPLAY_MODE_RESET } from './terminal-report-filter';
import { xtermCore } from './terminal-transfer';

const MOUSE_ENCODINGS = new Map<string | undefined, TerminalModes['mouseEncoding']>([
  ['SGR', 'sgr'],
  ['SGR_PIXELS', 'sgrPixels'],
]);

/** One screen's kitty state as the pushes that rebuild it. xterm keeps the
 * flags from before the first push at the stack's bottom, never read back. */
function kittyPushes(stack: number[], flags: number): number[] {
  if (stack.length === 0) return flags ? [flags] : [];
  return [...stack.slice(1), flags];
}

/** The modes the program in `terminal` has set, as an attach carries them to
 * a Client (`docs/specs/remote-api.md` -> "Terminal surfaces"). Read from
 * xterm's resolved state, as a Workspace transfer's replay is. */
export function readTerminalModes(terminal: Terminal): TerminalModes {
  const modes = terminal.modes;
  const core = xtermCore(terminal);
  const dec = core?.coreService?.decPrivateModes;
  const kitty = core?.coreService?.kittyKeyboard;
  const onAlt = terminal.buffer.active.type === 'alternate';
  return {
    applicationCursorKeys: modes.applicationCursorKeysMode,
    applicationKeypad: modes.applicationKeypadMode,
    bracketedPaste: modes.bracketedPasteMode,
    insert: modes.insertMode,
    origin: modes.originMode,
    reverseWraparound: modes.reverseWraparoundMode,
    wraparound: modes.wraparoundMode,
    showCursor: modes.showCursor,
    sendFocus: modes.sendFocusMode,
    mouseTracking: modes.mouseTrackingMode,
    mouseEncoding: MOUSE_ENCODINGS.get(core?.mouseStateService?.activeEncoding) ?? 'default',
    win32Input: modes.win32InputMode,
    colorSchemeUpdates: dec?.colorSchemeUpdates ?? false,
    cursorStyle: dec?.cursorStyle ?? 'default',
    cursorBlink: dec?.cursorBlink ?? false,
    alternateScreen: onAlt,
    kittyKeyboard: {
      main: kitty ? kittyPushes(kitty.mainStack, onAlt ? kitty.mainFlags : kitty.flags) : [],
      alternate: kitty && onAlt ? kittyPushes(kitty.altStack, kitty.flags) : [],
    },
  };
}

const MOUSE_TRACKING = new Map<unknown, number>([['x10', 9], ['vt200', 1000], ['drag', 1002], ['any', 1003]]);
const MOUSE_ENCODING = new Map<unknown, number>([['sgr', 1006], ['sgrPixels', 1016]]);
/** DECSCUSR's steady parameter for each style; the blinking one is one lower. */
const STEADY_CURSOR = new Map<unknown, number>([['block', 2], ['underline', 4], ['bar', 6]]);

/** The kitty keyboard protocol defines five flag bits. */
const isKittyFlags = (flags: unknown): flags is number => Number.isInteger(flags) && (flags as number) >= 0 && (flags as number) < 32;
const kittyPushReplay = (pushes: unknown): string =>
  (Array.isArray(pushes) ? pushes.filter(isKittyFlags) : []).map(flags => `${ESC}>${flags}u`).join('');

/** What puts a terminal into `modes` from whatever modes it held: a reset to
 * the defaults first, so a terminal this Client attached before keeps nothing
 * the program has since cleared, then every mode that differs. Built from a
 * peer's answer, so each field emits only its own fixed sequence and anything
 * malformed or missing reads as its default. win32-input-mode goes before any kitty push,
 * as the Workspace transfer's replay orders it. */
export function terminalModesReplay(answered: Partial<TerminalModes> | null | undefined): string {
  const modes = answered ?? {};
  const on = (value: unknown, sequence: string) => (value === true ? sequence : '');
  const off = (value: unknown, sequence: string) => (value === false ? sequence : '');
  const mouse = MOUSE_TRACKING.get(modes.mouseTracking);
  const encoding = MOUSE_ENCODING.get(modes.mouseEncoding);
  const cursor = STEADY_CURSOR.get(modes.cursorStyle);
  return REPLAY_MODE_RESET
    + on(modes.win32Input, `${ESC}?9001h`)
    + on(modes.applicationCursorKeys, `${ESC}?1h`)
    + on(modes.applicationKeypad, `${ESC}?66h`)
    + on(modes.bracketedPaste, `${ESC}?2004h`)
    + on(modes.insert, `${ESC}4h`)
    + on(modes.origin, `${ESC}?6h`)
    + on(modes.reverseWraparound, `${ESC}?45h`)
    + off(modes.wraparound, `${ESC}?7l`)
    + off(modes.showCursor, `${ESC}?25l`)
    + on(modes.sendFocus, `${ESC}?1004h`)
    + (mouse ? `${ESC}?${mouse}h` : '')
    + (encoding ? `${ESC}?${encoding}h` : '')
    + on(modes.colorSchemeUpdates, `${ESC}?2031h`)
    + (cursor ? `${ESC}${cursor - (modes.cursorBlink === true ? 1 : 0)} q` : '')
    + kittyPushReplay(modes.kittyKeyboard?.main)
    + on(modes.alternateScreen, `${ESC}?1049h${kittyPushReplay(modes.kittyKeyboard?.alternate)}`);
}
