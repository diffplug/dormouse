import { Terminal, type IBufferRange } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';
import { getPlatform, IS_MAC, isVSCodePlatform } from './platform';
import { requestExternalLinkConfirmation } from './external-link-confirmation';
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
  type PendingShellOpts,
  type TerminalEntry,
  type TerminalOverlayDims,
} from './terminal-store';
import { consumePrimedActivity, notifyActivityListeners } from './session-activity-store';
import { attachTerminalMouseRouter } from './terminal-mouse-router';
import {
  inputContainsEnter,
  inputIsReplayTerminalReport,
  inputIsSyntheticTerminalReport,
  stripMouseReportsFromInput,
  writeReplay,
} from './terminal-report-filter';
import { getTerminalTheme, paintTerminalHost, startThemeObserver } from './terminal-theme';
import {
  ensureTerminalPaneState,
  fillTerminalProcessCwdByPtyId,
  recordTerminalOutputByPtyId,
  recordTerminalUserInputByPtyId,
  removeTerminalPaneState,
  resetTerminalPaneState,
  seedPromptShapeFromScrollback,
  seedTerminalManualCwd,
  setTerminalUserTitle,
  swapTerminalPaneStates,
  type PromptLineReader,
} from './terminal-state-store';
import { readLogicalLineFromBuffer, type BufferLike } from './terminal-buffer-read';
import { UNNAMED_PANEL_TITLE } from './terminal-state';
import { vscodeWorkbenchCommandForKeydown } from './vscode-keybindings';

function makePromptLineReader(terminal: Terminal): PromptLineReader {
  return {
    readLine() {
      const buffer = terminal.buffer?.active;
      if (!buffer) return null;
      const cursorAbsRow = buffer.baseY + buffer.cursorY;
      const bufferLike: BufferLike = {
        getLine(index) {
          const line = buffer.getLine(index);
          if (!line) return undefined;
          return {
            isWrapped: line.isWrapped,
            translateToString: (trimRight, startColumn, endColumn) =>
              line.translateToString(trimRight, startColumn, endColumn),
          };
        },
      };
      return readLogicalLineFromBuffer(bufferLike, cursorAbsRow, buffer.cursorX);
    },
  };
}

function seedProcessCwdAfterSpawn(id: string): void {
  void getPlatform().getCwd(id).then((cwd) => fillTerminalProcessCwdByPtyId(id, cwd));
}

// Reconstructs the visible text from an OSC 8 hyperlink's buffer range. xterm
// passes the URL as the second arg to linkHandler.activate but not the rendered
// link text; we read it ourselves so the dialog can tell the user whether the
// label they clicked matched the URL. Wrapped lines concatenate without a
// separator (the wrap is visual, not a semantic break).
function readDisplayTextFromBuffer(terminal: Terminal, range: IBufferRange): string {
  try {
    const buffer = terminal.buffer.active;
    let text = '';
    for (let y = range.start.y; y <= range.end.y; y++) {
      const line = buffer.getLine(y - 1);
      if (!line) continue;
      const startCol = y === range.start.y ? range.start.x - 1 : 0;
      const endCol = y === range.end.y ? range.end.x : undefined;
      text += line.translateToString(true, startCol, endCol);
    }
    return text.trim();
  } catch {
    return '';
  }
}

function createXtermHost(): { terminal: Terminal; fit: FitAddon; element: HTMLDivElement } {
  const styles = getComputedStyle(document.body);
  const editorFontSize = parseInt(styles.getPropertyValue('--vscode-editor-font-size'), 10) || 12;
  const editorFontFamily = styles.getPropertyValue('--vscode-editor-font-family').trim() || "'SF Mono', Menlo, Monaco, monospace";

  const theme = getTerminalTheme();
  const terminal = new Terminal({
    allowProposedApi: true,
    fontSize: editorFontSize,
    fontFamily: editorFontFamily,
    cursorBlink: true,
    theme,
    vtExtensions: { kittyKeyboard: true },
    linkHandler: {
      activate: (event, uri, range) => {
        event.preventDefault();
        // Closure capture: `terminal` is defined by the time a click fires.
        requestExternalLinkConfirmation(uri, readDisplayTextFromBuffer(terminal, range));
      },
      allowNonHttpProtocols: true,
    },
  });

  if (isVSCodePlatform()) {
    terminal.attachCustomKeyEventHandler((event) => {
      const command = vscodeWorkbenchCommandForKeydown(event, { isMac: IS_MAC });
      if (!command) return true;
      event.preventDefault();
      event.stopPropagation();
      getPlatform().runWorkbenchCommand?.(command);
      return true;
    });
  }

  terminal.loadAddon(new UnicodeGraphemesAddon());
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
    if (detail.id === id) {
      recordTerminalOutputByPtyId(id, detail.data);
      terminal.write(detail.data);
    }
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
    let input = data;
    if (getMouseSelectionState(id).override !== 'off') {
      input = stripMouseReportsFromInput(input);
      if (input.length === 0) return;
    }

    const isReplayTerminalReport = inputIsReplayTerminalReport(input);

    if (isReplayTerminalReport && registry.get(id)?.isReplaying) return;

    if (!isReplayTerminalReport) {
      markSessionTouched(id);
    }

    const isSyntheticTerminalReport = inputIsSyntheticTerminalReport(input);

    if (!isSyntheticTerminalReport) {
      recordTerminalUserInputByPtyId(id, input, makePromptLineReader(terminal));
      const entry = registry.get(id);
      const hadTodo = entry?.todo === true;
      getPlatform().alertAttend(id);
      if (hadTodo && inputContainsEnter(input)) {
        getPlatform().alertClearTodo(id);
      }
    }

    getPlatform().writePty(id, input);
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

function setupTerminalEntry(id: string, options: { untouched?: boolean } = {}): TerminalEntry {
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
    alertStatus: 'WATCHING_DISABLED',
    watchingEnabled: false,
    todo: false,
    notification: null,
    attentionDismissedRing: false,
    isReplaying: false,
    untouched: options.untouched ?? false,
  };

  const primed = consumePrimedActivity(id);
  if (primed) {
    if (primed.status !== undefined) entry.alertStatus = primed.status;
    if (primed.watchingEnabled !== undefined) entry.watchingEnabled = primed.watchingEnabled;
    if (primed.todo !== undefined) entry.todo = primed.todo;
    if (primed.notification !== undefined) entry.notification = primed.notification;
  }

  registry.set(id, entry);
  ensureTerminalPaneState(id);
  notifyActivityListeners();
  startThemeObserver();
  return entry;
}

export function setPendingShellOpts(id: string, opts: PendingShellOpts): void {
  pendingShellOpts.set(id, opts);
}

export function getOrCreateTerminal(id: string): TerminalEntry {
  const existing = registry.get(id);
  if (existing) return existing;

  const entry = setupTerminalEntry(id, { untouched: true });
  resetTerminalPaneState(id);

  const shellOpts = pendingShellOpts.get(id);
  pendingShellOpts.delete(id);

  const dims = entry.fit.proposeDimensions();
  getPlatform().spawnPty(id, {
    cols: dims?.cols || 80,
    rows: dims?.rows || 30,
    ...shellOpts,
  });
  seedProcessCwdAfterSpawn(id);

  return entry;
}

export function resumeTerminal(
  id: string,
  replayData: string | null,
  exitInfo?: { alive: boolean; exitCode?: number; title?: string | null; untouched?: boolean },
): TerminalEntry {
  const existing = registry.get(id);
  if (existing) return existing;

  const entry = setupTerminalEntry(id, { untouched: exitInfo?.untouched ?? false });

  if (replayData) {
    writeReplay(entry, replayData);
    seedPromptShapeFromScrollback(id, replayData);
  }
  if (exitInfo && !exitInfo.alive) {
    entry.terminal.write(`\r\n[Process exited with code ${exitInfo.exitCode ?? -1}]\r\n`);
  }
  const savedTitle = exitInfo?.title?.trim();
  if (savedTitle && savedTitle !== UNNAMED_PANEL_TITLE) {
    setTerminalUserTitle(id, savedTitle);
  }

  return entry;
}

export function restoreTerminal(
  id: string,
  opts: { cwd?: string | null; scrollback?: string | null; title?: string | null; cwdWarning?: string | null; shell?: string; args?: string[]; untouched?: boolean },
): TerminalEntry {
  const existing = registry.get(id);
  if (existing) return existing;

  const entry = setupTerminalEntry(id, { untouched: opts.untouched ?? false });
  resetTerminalPaneState(id);
  seedTerminalManualCwd(id, opts.cwd);
  const trimmedTitle = opts.title?.trim();
  if (trimmedTitle && trimmedTitle !== UNNAMED_PANEL_TITLE) {
    setTerminalUserTitle(id, trimmedTitle);
  }

  if (opts.scrollback) {
    writeReplay(entry, opts.scrollback, '\r\n');
    seedPromptShapeFromScrollback(id, opts.scrollback);
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
  seedProcessCwdAfterSpawn(id);

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
  removeTerminalPaneState(id);
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
  swapTerminalPaneStates(idA, idB);

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

export function isUntouched(id: string): boolean {
  return registry.get(id)?.untouched ?? false;
}

export function markSessionTouched(id: string): void {
  const entry = registry.get(id);
  if (!entry || !entry.untouched) return;
  entry.untouched = false;
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
