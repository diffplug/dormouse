import type { Terminal } from '@xterm/xterm';
import type { SerializeAddon } from '@xterm/addon-serialize';
import { ESC } from './ansi';

export interface TerminalGrid { cols: number; rows: number }

interface KittyKeyboardState { flags: number; mainFlags: number; mainStack: number[]; altStack: number[] }

interface DecPrivateModes {
  colorSchemeUpdates: boolean;
  win32InputMode: boolean;
  cursorStyle?: 'block' | 'underline' | 'bar';
  cursorBlink?: boolean;
}

/** DECSCUSR's steady parameter for each style; the blinking one is one lower. */
const STEADY_CURSOR = { block: 2, underline: 4, bar: 6 };

function modeReplay({ colorSchemeUpdates, win32InputMode, cursorStyle, cursorBlink }: DecPrivateModes): string {
  return (win32InputMode ? `${ESC}?9001h` : '')
    + (colorSchemeUpdates ? `${ESC}?2031h` : '')
    + (cursorStyle ? `${ESC}${STEADY_CURSOR[cursorStyle] - (cursorBlink ? 1 : 0)} q` : '');
}

/** Rebuilds one screen's kitty state on a fresh terminal. Pushes, so later pops
 * and the Windows arbiter's depth match the source. xterm zeroes the flags when
 * a pop empties the stack, so the stack's bottom entry is never read back. */
function kittyReplay(stack: number[], flags: number): string {
  if (stack.length === 0) return flags ? `${ESC}=${flags};1u` : '';
  return [...stack.slice(1), flags].map(entry => `${ESC}>${entry}u`).join('');
}

/** The pinned serializer omits what a running app negotiates beyond its fixed
 * mode list: mouse encoding (xtermjs/xterm.js#6174, still open upstream), kitty
 * keyboard state, win32-input-mode, color-scheme reports and cursor style. Read
 * xterm's resolved state, including resets, rather than infer it from output
 * chunks. These private accessors are pinned by real-xterm round-trip tests in
 * terminal-transfer.test.ts.
 *
 * win32-input-mode goes before any kitty push: the arriving arbiter turns that
 * extension off on the first push, and xterm then ignores the mode.
 *
 * Main-screen kitty state goes first when the alternate screen is active: the
 * serialized content enters that screen, and leaving it again would clear it.
 * Alternate-screen state is dropped while the main screen is active, for the
 * same reason.
 */
export function serializeTransferTerminal(terminal: Terminal, serialize: SerializeAddon): string {
  const core = (terminal as unknown as {
    _core?: {
      mouseStateService?: { activeEncoding?: string };
      coreService?: { decPrivateModes: DecPrivateModes; kittyKeyboard: KittyKeyboardState };
    };
  })._core;
  const encoding = core?.mouseStateService?.activeEncoding;
  const mouse = encoding === 'SGR' ? `${ESC}?1006h` : encoding === 'SGR_PIXELS' ? `${ESC}?1016h` : '';
  const content = serialize.serialize() + mouse;
  if (!core?.coreService) return content;
  const { decPrivateModes, kittyKeyboard: kitty } = core.coreService;
  const onAlt = terminal.buffer.active.type === 'alternate';
  const before = onAlt ? kittyReplay(kitty.mainStack, kitty.mainFlags) : '';
  const after = kittyReplay(onAlt ? kitty.altStack : kitty.mainStack, kitty.flags);
  return modeReplay(decPrivateModes) + before + content + after;
}
