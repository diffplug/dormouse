import type { Terminal } from '@xterm/xterm';
import type { SerializeAddon } from '@xterm/addon-serialize';
import { ESC } from './ansi';

export interface TerminalGrid { cols: number; rows: number }

interface KittyKeyboardState { flags: number; mainFlags: number; mainStack: number[]; altStack: number[] }

export interface DecPrivateModes {
  colorSchemeUpdates: boolean;
  win32InputMode: boolean;
  cursorStyle?: 'block' | 'underline' | 'bar';
  cursorBlink?: boolean;
}

/** DECSCUSR's steady parameter for each style; the blinking one is one lower. */
const STEADY_CURSOR = { block: 2, underline: 4, bar: 6 };

function modeReplay({ colorSchemeUpdates, win32InputMode, cursorStyle, cursorBlink }: DecPrivateModes, mouseEncoding?: string): string {
  return (win32InputMode ? `${ESC}?9001h` : '')
    + (colorSchemeUpdates ? `${ESC}?2031h` : '')
    + (cursorStyle ? `${ESC}${STEADY_CURSOR[cursorStyle] - (cursorBlink ? 1 : 0)} q` : '')
    + (mouseEncoding === 'SGR' ? `${ESC}?1006h` : mouseEncoding === 'SGR_PIXELS' ? `${ESC}?1016h` : '');
}

/** Rebuilds one screen's kitty state on a fresh terminal. Pushes, so later pops
 * and the Windows arbiter's depth match the source. xterm zeroes the flags when
 * a pop empties the stack, so the stack's bottom entry is never read back. */
function kittyReplay(stack: number[], flags: number): string {
  if (stack.length === 0) return flags ? `${ESC}=${flags};1u` : '';
  return [...stack.slice(1), flags].map(entry => `${ESC}>${entry}u`).join('');
}

/** The pinned serializer emits a fixed list of modes, so this replays what a
 * running app set beyond it (`docs/specs/transport.md` -> "Transferring a
 * Workspace"). Read xterm's resolved state, including resets, rather than infer
 * it from output chunks. These private accessors are pinned by real-xterm
 * round-trip tests in terminal-transfer.test.ts.
 *
 * Everything precedes the serialized content except alternate-screen kitty
 * state, which needs that content to enter the screen. While the main screen is
 * active that state is dropped: restoring it would mean entering and leaving the
 * alternate screen in the new terminal.
 *
 * win32-input-mode goes before any kitty push: the arriving arbiter turns that
 * extension off on the first push, and xterm then ignores the mode.
 */
export function serializeTransferTerminal(terminal: Terminal, serialize: SerializeAddon): string {
  const core = (terminal as unknown as {
    _core?: {
      mouseStateService?: { activeEncoding?: string };
      coreService?: { decPrivateModes: DecPrivateModes; kittyKeyboard: KittyKeyboardState };
    };
  })._core;
  const content = serialize.serialize();
  if (!core?.coreService || !core.mouseStateService) return content;
  const { decPrivateModes, kittyKeyboard: kitty } = core.coreService;
  const onAlt = terminal.buffer.active.type === 'alternate';
  const main = kittyReplay(kitty.mainStack, onAlt ? kitty.mainFlags : kitty.flags);
  const alt = onAlt ? kittyReplay(kitty.altStack, kitty.flags) : '';
  return modeReplay(decPrivateModes, core.mouseStateService.activeEncoding) + main + content + alt;
}
