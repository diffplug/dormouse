import { Terminal } from '@xterm/xterm';
import { registry } from './terminal-store';
import type { TerminalColorProvider } from './terminal-protocol';

/**
 * The xterm `ITheme`, read straight off `body`'s resolved `--vscode-*`.
 *
 * No per-key hex defaults: `REGISTRY_DEFAULTS` in `themes/vscode-color-registry.ts`
 * is the one table of what an unset VSCode color id resolves to, and every
 * shipping host materializes these keys before a terminal renders
 * (docs/specs/theme.md -> Terminal color contract). A second table here drifted
 * from it — `#cccccc` against the registry's `#BBBBBB` for dark
 * `editor-foreground` — and would have painted the terminal with the stale one.
 *
 * Background and foreground keep a last-resort pair anyway, because xterm.js
 * needs two readable colors even in the one path that has no resolver behind it
 * (`pnpm dev:lib`); the rest of the palette degrades to xterm's own defaults.
 */
const FALLBACK_BACKGROUND = '#1e1e1e';
const FALLBACK_FOREGROUND = '#cccccc';

/** xterm `ITheme` key -> the `--vscode-*` variable that fills it. */
const ANSI_VARS: Record<string, string> = {
  selectionBackground: '--vscode-terminal-selectionBackground',
  black: '--vscode-terminal-ansiBlack',
  red: '--vscode-terminal-ansiRed',
  green: '--vscode-terminal-ansiGreen',
  yellow: '--vscode-terminal-ansiYellow',
  blue: '--vscode-terminal-ansiBlue',
  magenta: '--vscode-terminal-ansiMagenta',
  cyan: '--vscode-terminal-ansiCyan',
  white: '--vscode-terminal-ansiWhite',
  brightBlack: '--vscode-terminal-ansiBrightBlack',
  brightRed: '--vscode-terminal-ansiBrightRed',
  brightGreen: '--vscode-terminal-ansiBrightGreen',
  brightYellow: '--vscode-terminal-ansiBrightYellow',
  brightBlue: '--vscode-terminal-ansiBrightBlue',
  brightMagenta: '--vscode-terminal-ansiBrightMagenta',
  brightCyan: '--vscode-terminal-ansiBrightCyan',
  brightWhite: '--vscode-terminal-ansiBrightWhite',
};

export function getTerminalTheme(): Record<string, string> {
  const style = getComputedStyle(document.body);
  const v = (prop: string, fallback = '') => style.getPropertyValue(prop).trim() || fallback;
  const foreground = v('--vscode-terminal-foreground', v('--vscode-editor-foreground', FALLBACK_FOREGROUND));
  const theme: Record<string, string> = {
    background: v('--vscode-terminal-background', v('--vscode-editor-background', FALLBACK_BACKGROUND)),
    foreground,
    // Derived, not defaulted: `RESOLUTION_RULES` inherits the cursor from the
    // terminal foreground, and the three keys a DOM-less host is pushed
    // (`setThemeColors` in lib/src/host/remote/sidecar-entry.ts) must all be
    // strings or the whole push is dropped.
    cursor: v('--vscode-terminalCursor-foreground', foreground),
  };
  // Omitted rather than emptied: an unset key leaves xterm.js on its own
  // default, and leaves `themeColorProvider` answering `null` to an OSC query.
  for (const [key, prop] of Object.entries(ANSI_VARS)) {
    const value = v(prop);
    if (value) theme[key] = value;
  }
  return theme;
}

/**
 * Answers OSC 10/11/12 foreground/background/cursor color queries from the live
 * xterm theme. Read lazily per query so it tracks theme changes. Every parser
 * in a realm that *has* the theme takes this — the fake adapter, and each
 * webview's one-shot replay parser; a parser that declines leaves the query in
 * `visibleData` for xterm.js to answer into the PTY. The two hosts whose owner
 * has no DOM are pushed these same colors instead.
 */
export const themeColorProvider: TerminalColorProvider = (target) => getTerminalTheme()[target] ?? null;

const XTERM_HOST_SELECTOR = '.xterm-screen, .xterm-scrollable-element, .xterm-viewport';
let xtermSelectorWarned = false;

export function paintTerminalHost(element: HTMLDivElement, terminal: Terminal, background: string): void {
  element.style.backgroundColor = background;
  element.style.borderRadius = 'inherit';

  const xtermElement = terminal.element as HTMLElement | undefined;
  if (xtermElement) {
    xtermElement.style.backgroundColor = background;
    xtermElement.style.borderRadius = 'inherit';
  }

  if (typeof element.querySelectorAll !== 'function') return;
  const hosts = element.querySelectorAll<HTMLElement>(XTERM_HOST_SELECTOR);
  if (hosts.length === 0 && xtermElement && !xtermSelectorWarned) {
    xtermSelectorWarned = true;
    console.warn(`[dormouse] paintTerminalHost: no elements matched ${XTERM_HOST_SELECTOR} - xterm DOM may have changed.`);
    return;
  }
  hosts.forEach((el) => {
    el.style.backgroundColor = background;
  });
}

let themeObserverStarted = false;
let lastAppliedThemeKey: string | null = null;
const themeChangeListeners = new Set<() => void>();

/**
 * Subscribe to terminal theme changes, fired by the shared theme observer when
 * the resolved theme actually changes. The VS Code adapter uses this to push
 * current colors to the extension host (which has no DOM) so its parser can
 * answer OSC color queries. Returns an unsubscribe function.
 */
export function onTerminalThemeChange(listener: () => void): () => void {
  themeChangeListeners.add(listener);
  return () => { themeChangeListeners.delete(listener); };
}

export function startThemeObserver(): void {
  if (themeObserverStarted) return;
  themeObserverStarted = true;

  const observer = new MutationObserver(() => {
    const theme = getTerminalTheme();
    const key = JSON.stringify(theme);
    if (key === lastAppliedThemeKey) return;
    lastAppliedThemeKey = key;
    for (const entry of registry.values()) {
      entry.terminal.options.theme = theme;
      paintTerminalHost(entry.element, entry.terminal, theme.background);
    }
    for (const listener of themeChangeListeners) listener();
  });

  // class + style on both roots, matching the resolver's observer
  // (vscode-color-observer.ts) so a theme signaled via an <html> class
  // mutation also refreshes the terminal palette.
  observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
}
