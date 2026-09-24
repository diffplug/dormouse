import type { ITerminalOptions } from '@xterm/xterm';
import { IS_WINDOWS } from './platform';

/**
 * The negotiated VT extensions every terminal offers. kittyKeyboard
 * disambiguates Shift+Enter from Enter for TUIs that read raw VT (Claude Code
 * everywhere; Codex on macOS/Linux). win32InputMode covers Windows TUIs that
 * read via the Console API behind ConPTY (Codex), which can't negotiate the
 * kitty protocol there: when conhost enables it (CSI ? 9001 h), xterm sends
 * faithful Win32 INPUT_RECORD key events so Shift+Enter and Ctrl+J reach the
 * app intact. Both are opt-in/negotiated, so they coexist — each program turns
 * on whichever it understands. colorSchemeQuery answers DSR 996 and DECSET
 * 2031, which the advertised iTerm2 version promises
 * (docs/specs/terminal-escapes.md -> iTerm2 identity).
 */
export function xtermVtExtensions(): ITerminalOptions['vtExtensions'] {
  return { kittyKeyboard: true, win32InputMode: IS_WINDOWS, colorSchemeQuery: true };
}
