import type { Terminal } from '@xterm/xterm';
import type { TerminalModes } from 'remote-lib-common';
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
