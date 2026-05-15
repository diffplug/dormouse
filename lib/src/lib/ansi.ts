// Shared ANSI escape sequences for browser-side TUI runners and fake
// scenarios. Anything that emits raw ANSI to xterm.js should import from
// here rather than rolling its own ESC = "\x1b[" copy.

export const ESC = "\x1b[";
export const RESET = `${ESC}0m`;
export const BOLD = `${ESC}1m`;
export const DIM = `${ESC}2m`;
export const ITALIC = `${ESC}3m`;
export const FG_DEFAULT = `${ESC}39m`;
export const CLEAR_LINE = `${ESC}2K`;
export const CLEAR_SCREEN = `${ESC}2J`;
export const CURSOR_HOME = `${ESC}H`;

// Standard 16-color foregrounds. `fg(36)` etc. for arbitrary codes.
export const fg = (code: number): string => `${ESC}${code}m`;

// Alt-screen toggles paired with full clear + cursor visibility flips.
// Use these for full-screen TUIs (tut, ascii-splash) so exiting restores
// whatever was on screen before.
export const ENTER_ALT_SCREEN = `${ESC}?1049h${CLEAR_SCREEN}${CURSOR_HOME}${ESC}?25l`;
export const LEAVE_ALT_SCREEN = `${CLEAR_SCREEN}${CURSOR_HOME}${ESC}?25h${ESC}?1049l`;

// SGR mouse-reporting toggles. xterm parses these and the wall's
// mouse-mode-observer flips the cursor-icon override on/off so the user
// knows Dormouse is "trapping the mouse" while the program runs.
export const MOUSE_ENABLE = `${ESC}?1000h${ESC}?1002h${ESC}?1003h${ESC}?1006h`;
export const MOUSE_DISABLE = `${ESC}?1003l${ESC}?1002l${ESC}?1000l${ESC}?1006l`;

// Stylized `user@dormouse:~$ ` prompt used by the playground shell and
// by canned scenarios so they look the same.
export const PROMPT = `${fg(32)}user${RESET}@${fg(36)}dormouse${RESET}:${BOLD}${fg(34)}~${RESET}$ `;
