import type { Terminal, IDisposable } from '@xterm/xterm';

/**
 * Arbitrate between the kitty keyboard protocol and win32-input-mode on Windows.
 *
 * Dormouse advertises both (`vtExtensions: { kittyKeyboard, win32InputMode }`),
 * but xterm.js treats them as mutually exclusive: `useWin32InputMode` is checked
 * first in `evaluateKeyDown`, so whenever win32-input-mode is active it wins for
 * every keypress and the kitty protocol is never consulted. win32-input-mode
 * becomes active as soon as the pane receives `CSI ? 9001 h`, which ConPTY's
 * conhost emits proactively — so on Windows it would clobber kitty for *every*
 * app, including kitty-based TUIs like Claude Code that rely on kitty's
 * Shift+Enter disambiguation.
 *
 * Both `useWin32InputMode` and `useKitty` re-read the live `vtExtensions` option
 * on every keypress, so we keep them from colliding by toggling the option:
 * win32-input-mode starts enabled (Console-API TUIs like Codex need it), and the
 * moment a foreground app pushes the kitty protocol (`CSI > … u`) we disable it
 * for the pane so kitty wins. On kitty pop (`CSI < … u`) we restore it. Apps that
 * never touch kitty (Codex) keep win32-input-mode the whole time.
 *
 * Only meaningful on Windows — elsewhere `win32InputMode` is never advertised, so
 * kitty already wins unconditionally and this arbiter is not attached.
 */
export function attachKeyboardProtocolArbiter(terminal: Terminal): IDisposable {
  const setWin32InputMode = (enabled: boolean) => {
    const ext = terminal.options.vtExtensions;
    if (!!ext?.win32InputMode === enabled) return;
    // Reassign the whole object — nested mutation would not trip the option
    // setter. Spreading preserves kittyKeyboard (and any other extensions).
    terminal.options.vtExtensions = { ...ext, win32InputMode: enabled };
  };

  // We track the push/pop stack ops only — the set-flags form (`CSI = … u`) is
  // not observed, since the kitty TUIs we care about (Claude Code) enable the
  // protocol via push. Return false so xterm still processes the sequence.
  const onKittyPush = terminal.parser.registerCsiHandler({ prefix: '>', final: 'u' }, () => {
    setWin32InputMode(false);
    return false;
  });
  const onKittyPop = terminal.parser.registerCsiHandler({ prefix: '<', final: 'u' }, () => {
    setWin32InputMode(true);
    return false;
  });

  return {
    dispose() {
      onKittyPush.dispose();
      onKittyPop.dispose();
    },
  };
}
