import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { getPlatform } from './platform';
import { attachMouseModeObserver } from './mouse-mode-observer';
import {
  bumpRenderTick,
  getMouseSelectionState,
  removeMouseSelectionState,
  setSelection as setMouseSelection,
} from './mouse-selection';
import { extractSelectionText } from './selection-text';
import {
  pendingShellOpts,
  registry,
  type TerminalEntry,
  type TerminalOverlayDims,
} from './terminal-store';
import { consumePrimedActivity, notifyActivityListeners } from './session-activity-store';
import { attachTerminalMouseRouter } from './terminal-mouse-router';
import {
  inputContainsEnter,
  inputIsReplayTerminalReport,
  inputIsSyntheticTerminalReport,
  writeReplay,
} from './terminal-report-filter';
import { getTerminalTheme, paintTerminalHost, startThemeObserver } from './terminal-theme';

function createXtermHost(): { terminal: Terminal; fit: FitAddon; element: HTMLDivElement } {
  const styles = getComputedStyle(document.body);
  const editorFontSize = parseInt(styles.getPropertyValue('--vscode-editor-font-size'), 10) || 12;
  const editorFontFamily = styles.getPropertyValue('--vscode-editor-font-family').trim() || "'SF Mono', Menlo, Monaco, monospace";

  const theme = getTerminalTheme();
  const terminal = new Terminal({
    fontSize: editorFontSize,
    fontFamily: editorFontFamily,
    cursorBlink: true,
    theme,
  });

  const fit = new FitAddon();
  terminal.loadAddon(fit);

  const element = document.createElement('div');
  element.style.width = '100%';
  element.style.height = '100%';
  terminal.open(element);
  paintTerminalHost(element, terminal, theme.background);

  return { terminal, fit, element };
}

/** PTY data/exit listeners. Returns the unsubscribe pair. */
function wirePtyEvents(id: string, terminal: Terminal): () => void {
  const platform = getPlatform();
  const handleData = (detail: { id: string; data: string }) => {
    if (detail.id === id) terminal.write(detail.data);
  };
  const handleExit = (detail: { id: string; exitCode: number }) => {
    if (detail.id === id) terminal.write(`\r\n[Process exited with code ${detail.exitCode}]\r\n`);
  };
  platform.onPtyData(handleData);
  platform.onPtyExit(handleExit);
  return () => {
    platform.offPtyData(handleData);
    platform.offPtyExit(handleExit);
  };
}

/** xterm input/resize/render handlers. Returns a dispose. The render
 *  handler watches selectionBaseline (mutated by the mouse router) so the
 *  baseline is read by reference rather than captured. */
function wireXtermHandlers(
  id: string,
  terminal: Terminal,
  selectionBaselineRef: { current: string | null },
): () => void {
  const inputDisposable = terminal.onData((data) => {
    const isSyntheticTerminalReport = inputIsSyntheticTerminalReport(data);

    if (inputIsReplayTerminalReport(data) && registry.get(id)?.isReplaying) return;

    if (!isSyntheticTerminalReport) {
      const entry = registry.get(id);
      const hadTodo = entry?.todo === true;
      getPlatform().alertAttend(id);
      if (hadTodo && inputContainsEnter(data)) {
        getPlatform().alertClearTodo(id);
      }
    }

    getPlatform().writePty(id, data);
  });

  const resizeDisposable = terminal.onResize(({ cols, rows }) => {
    getPlatform().alertResize(id);
    getPlatform().resizePty(id, cols, rows);
    bumpRenderTick();
    if (getMouseSelectionState(id).selection) setMouseSelection(id, null);
    selectionBaselineRef.current = null;
  });

  const renderDisposable = terminal.onRender(() => {
    bumpRenderTick();
    if (selectionBaselineRef.current === null) return;
    const sel = getMouseSelectionState(id).selection;
    if (!sel || sel.dragging) {
      selectionBaselineRef.current = null;
      return;
    }
    const current = extractSelectionText(terminal, sel);
    if (current !== selectionBaselineRef.current) {
      setMouseSelection(id, null);
      selectionBaselineRef.current = null;
    }
  });

  return () => {
    inputDisposable.dispose();
    resizeDisposable.dispose();
    renderDisposable.dispose();
  };
}

function setupTerminalEntry(id: string): TerminalEntry {
  const { terminal, fit, element } = createXtermHost();
  const selectionBaselineRef = { current: null as string | null };

  const disposePty = wirePtyEvents(id, terminal);
  const disposeXterm = wireXtermHandlers(id, terminal, selectionBaselineRef);
  const mouseModeObserver = attachMouseModeObserver(id, terminal);
  const cleanupMouseRouter = attachTerminalMouseRouter({
    id,
    terminal,
    element,
    getOverlayDims: getTerminalOverlayDims,
    setSelectionBaseline: (baseline) => {
      selectionBaselineRef.current = baseline;
    },
  });

  const cleanup = () => {
    disposePty();
    disposeXterm();
    mouseModeObserver.dispose();
    cleanupMouseRouter();
  };

  const entry: TerminalEntry = {
    ptyId: id,
    terminal,
    fit,
    element,
    cleanup,
    alertStatus: 'ALERT_DISABLED',
    todo: false,
    notification: null,
    attentionDismissedRing: false,
    isReplaying: false,
  };

  const primed = consumePrimedActivity(id);
  if (primed) {
    if (primed.status !== undefined) entry.alertStatus = primed.status;
    if (primed.todo !== undefined) entry.todo = primed.todo;
    if (primed.notification !== undefined) entry.notification = primed.notification;
  }

  registry.set(id, entry);
  notifyActivityListeners();
  startThemeObserver();
  return entry;
}

export function setPendingShellOpts(id: string, opts: { shell?: string; args?: string[] }): void {
  pendingShellOpts.set(id, opts);
}

export function getOrCreateTerminal(id: string): TerminalEntry {
  const existing = registry.get(id);
  if (existing) return existing;

  const entry = setupTerminalEntry(id);

  const shellOpts = pendingShellOpts.get(id);
  pendingShellOpts.delete(id);

  const dims = entry.fit.proposeDimensions();
  getPlatform().spawnPty(id, {
    cols: dims?.cols || 80,
    rows: dims?.rows || 30,
    ...shellOpts,
  });

  return entry;
}

export function resumeTerminal(
  id: string,
  replayData: string | null,
  exitInfo?: { alive: boolean; exitCode?: number },
): TerminalEntry {
  const existing = registry.get(id);
  if (existing) return existing;

  const entry = setupTerminalEntry(id);

  if (replayData) {
    writeReplay(entry, replayData);
  }
  if (exitInfo && !exitInfo.alive) {
    entry.terminal.write(`\r\n[Process exited with code ${exitInfo.exitCode ?? -1}]\r\n`);
  }

  return entry;
}

export function restoreTerminal(
  id: string,
  opts: { cwd?: string | null; scrollback?: string | null; title?: string; cwdWarning?: string | null; shell?: string; args?: string[] },
): TerminalEntry {
  const existing = registry.get(id);
  if (existing) return existing;

  const entry = setupTerminalEntry(id);

  if (opts.scrollback) {
    writeReplay(entry, opts.scrollback, '\r\n');
  }
  if (opts.cwdWarning) {
    entry.terminal.write(`\r\n\x1b[33m${opts.cwdWarning}\x1b[0m\r\n`);
  }

  const dims = entry.fit.proposeDimensions();
  getPlatform().spawnPty(id, {
    cols: dims?.cols || 80,
    rows: dims?.rows || 30,
    cwd: opts.cwd ?? undefined,
    shell: opts.shell,
    args: opts.args,
  });

  return entry;
}

export function mountElement(id: string, container: HTMLElement): void {
  const entry = registry.get(id);
  if (!entry) return;
  container.appendChild(entry.element);
  requestAnimationFrame(() => entry.fit.fit());
}

export function unmountElement(id: string): void {
  const entry = registry.get(id);
  if (!entry) return;
  entry.element.remove();
}

export function disposeAllSessions(): void {
  for (const id of [...registry.keys()]) {
    disposeSession(id);
  }
}

export function disposeSession(id: string): void {
  const entry = registry.get(id);
  if (!entry) return;
  getPlatform().alertRemove(entry.ptyId);
  entry.cleanup();
  getPlatform().killPty(entry.ptyId);
  entry.element.remove();
  entry.terminal.dispose();
  registry.delete(id);
  removeMouseSelectionState(id);
  notifyActivityListeners();
}

export function swapTerminals(idA: string, idB: string): void {
  const entryA = registry.get(idA);
  const entryB = registry.get(idB);
  if (!entryA || !entryB) return;

  const containerA = entryA.element.parentElement;
  const containerB = entryB.element.parentElement;

  entryA.element.remove();
  entryB.element.remove();

  registry.set(idA, entryB);
  registry.set(idB, entryA);

  if (containerA) {
    containerA.appendChild(entryB.element);
    requestAnimationFrame(() => entryB.fit.fit());
  }
  if (containerB) {
    containerB.appendChild(entryA.element);
    requestAnimationFrame(() => entryA.fit.fit());
  }

  notifyActivityListeners();
}

export function refitSession(id: string): void {
  const entry = registry.get(id);
  if (!entry) return;
  entry.fit.fit();
}

export function getTerminalInstance(id: string): Terminal | null {
  return registry.get(id)?.terminal ?? null;
}

export function getTerminalOverlayDims(id: string): TerminalOverlayDims | null {
  const entry = registry.get(id);
  if (!entry) return null;
  const elementRect = entry.element.getBoundingClientRect();
  const screen = entry.element.querySelector<HTMLElement>('.xterm-screen');
  let cellWidth: number;
  let cellHeight: number;
  let gridLeft: number;
  let gridTop: number;
  if (screen) {
    const screenRect = screen.getBoundingClientRect();
    cellWidth = screenRect.width / entry.terminal.cols;
    cellHeight = screenRect.height / entry.terminal.rows;
    gridLeft = screenRect.left - elementRect.left;
    gridTop = screenRect.top - elementRect.top;
  } else {
    cellWidth = elementRect.width / entry.terminal.cols;
    cellHeight = elementRect.height / entry.terminal.rows;
    gridLeft = 0;
    gridTop = 0;
  }
  return {
    cols: entry.terminal.cols,
    rows: entry.terminal.rows,
    viewportY: entry.terminal.buffer.active.viewportY,
    baseY: entry.terminal.buffer.active.baseY,
    elementWidth: elementRect.width,
    elementHeight: elementRect.height,
    cellWidth,
    cellHeight,
    gridLeft,
    gridTop,
  };
}

export function focusSession(id: string, focused: boolean): void {
  const entry = registry.get(id);
  if (!entry) return;

  if (focused) {
    entry.terminal.focus();
  } else {
    entry.terminal.blur();
    getPlatform().alertClearAttention(entry.ptyId);
  }
}
