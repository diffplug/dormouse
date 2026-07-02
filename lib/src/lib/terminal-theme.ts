import { Terminal } from '@xterm/xterm';
import { registry } from './terminal-store';
import type { TerminalColorProvider } from './terminal-protocol';

export function getTerminalTheme(): Record<string, string> {
  const style = getComputedStyle(document.body);
  const v = (prop: string, fallback: string) => style.getPropertyValue(prop).trim() || fallback;
  return {
    background: v('--vscode-terminal-background', v('--vscode-editor-background', '#1e1e1e')),
    foreground: v('--vscode-terminal-foreground', v('--vscode-editor-foreground', '#cccccc')),
    cursor: v('--vscode-terminalCursor-foreground', '#aeafad'),
    selectionBackground: v('--vscode-terminal-selectionBackground', '#264f7840'),
    black: v('--vscode-terminal-ansiBlack', '#000000'),
    red: v('--vscode-terminal-ansiRed', '#cd3131'),
    green: v('--vscode-terminal-ansiGreen', '#0dbc79'),
    yellow: v('--vscode-terminal-ansiYellow', '#e5e510'),
    blue: v('--vscode-terminal-ansiBlue', '#2472c8'),
    magenta: v('--vscode-terminal-ansiMagenta', '#bc3fbc'),
    cyan: v('--vscode-terminal-ansiCyan', '#11a8cd'),
    white: v('--vscode-terminal-ansiWhite', '#e5e5e5'),
    brightBlack: v('--vscode-terminal-ansiBrightBlack', '#666666'),
    brightRed: v('--vscode-terminal-ansiBrightRed', '#f14c4c'),
    brightGreen: v('--vscode-terminal-ansiBrightGreen', '#23d18b'),
    brightYellow: v('--vscode-terminal-ansiBrightYellow', '#f5f543'),
    brightBlue: v('--vscode-terminal-ansiBrightBlue', '#3b8eea'),
    brightMagenta: v('--vscode-terminal-ansiBrightMagenta', '#d670d6'),
    brightCyan: v('--vscode-terminal-ansiBrightCyan', '#29b8db'),
    brightWhite: v('--vscode-terminal-ansiBrightWhite', '#e5e5e5'),
  };
}

/**
 * Answers OSC 10/11/12 foreground/background/cursor color queries from the live
 * xterm theme. Read lazily per query so it tracks theme changes. Frontend
 * platform adapters pass this to their `TerminalProtocolParser`s.
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

  observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
}
