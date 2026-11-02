import type { Terminal } from '@xterm/xterm';
import type { SerializeAddon } from '@xterm/addon-serialize';
import { ESC } from './ansi';

export interface TerminalGrid { cols: number; rows: number }

interface KittyKeyboardState { flags: number; mainFlags: number; mainStack: number[]; altStack: number[] }

/** Rebuilds one screen's kitty state on a fresh terminal. Pushes, so later pops
 * and the Windows arbiter's depth match the source. xterm zeroes the flags when
 * a pop empties the stack, so the stack's bottom entry is never read back. */
function kittyReplay(stack: number[], flags: number): string {
  if (stack.length === 0) return flags ? `${ESC}=${flags};1u` : '';
  return [...stack.slice(1), flags].map(entry => `${ESC}>${entry}u`).join('');
}

/** The pinned serializer omits mouse encoding (xtermjs/xterm.js#6174, still
 * open upstream) and every kitty keyboard flag. Read xterm's
 * resolved state, including resets, rather than infer it from output chunks.
 * These private accessors are pinned by real-xterm round-trip tests in
 * terminal-transfer.test.ts.
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
      coreService?: { kittyKeyboard?: KittyKeyboardState };
    };
  })._core;
  const encoding = core?.mouseStateService?.activeEncoding;
  const mouse = encoding === 'SGR' ? `${ESC}?1006h` : encoding === 'SGR_PIXELS' ? `${ESC}?1016h` : '';
  const content = serialize.serialize() + mouse;
  const kitty = core?.coreService?.kittyKeyboard;
  if (!kitty) return content;
  const onAlt = terminal.buffer.active.type === 'alternate';
  const before = onAlt ? kittyReplay(kitty.mainStack, kitty.mainFlags) : '';
  const after = kittyReplay(onAlt ? kitty.altStack : kitty.mainStack, kitty.flags);
  return before + content + after;
}
