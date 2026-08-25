import { Terminal, type IBufferRange } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';
import { WebglAddon } from '@xterm/addon-webgl';
import { shellCommandKind, type ShellCommandKind } from 'dor/commands/shell-quote';
import { getPlatform, IS_MAC, IS_WINDOWS, PLATFORM_STRING } from './platform';
import { DIM, RESET } from './ansi';
import { cfg } from '../cfg';
import { requestExternalLinkConfirmation } from './external-link-confirmation';
import { attachMouseModeObserver } from './mouse-mode-observer';
import { attachKeyboardProtocolArbiter } from './keyboard-protocol-arbiter';
import {
  bumpRenderTick,
  getMouseSelectionState,
  removeMouseSelectionState,
  setSelection as setMouseSelection,
} from './mouse-selection';
import { extractSelectionText } from './selection-text';
import { normalizeResumeCommand } from './resume-patterns';
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
  REPLAY_MODE_RESET,
  stripMouseReportsFromInput,
  writeReplay,
} from './terminal-report-filter';
import { getTerminalTheme, paintTerminalHost, startThemeObserver } from './terminal-theme';
import {
  ensureTerminalPaneState,
  fillTerminalProcessCwdByPtyId,
  finishLaunchedCommandByPtyId,
  getTerminalPaneState,
  isPaneOscDriven,
  recordTerminalOutputByPtyId,
  recordTerminalUserInputByPtyId,
  removeTerminalPaneState,
  resetTerminalPaneState,
  seedLaunchedCommand,
  seedPromptShapeFromScrollback,
  seedTerminalManualCwd,
  setTerminalUserTitle,
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

/**
 * Swap xterm's DOM renderer for the WebGL one, and record which one this
 * terminal ended up on as `data-renderer` on its host element.
 *
 * The DOM renderer emits one `<span>` per style run per row, so a TUI that
 * paints every cell a different truecolor (an animated pattern, `btop`, a
 * syntax-highlighted pager) turns into one span-with-inline-style per cell,
 * rebuilt every frame. On a 99x25 pane that is ~1150 elements of style
 * recalc + layout per frame; WebKit spends ~95ms/frame on it and the whole
 * page drops to ~9fps. The WebGL renderer rasterizes the same grid from a
 * glyph atlas and leaves the DOM untouched.
 *
 * Called on first MOUNT, not on create: a GL context is a scarce per-page
 * resource (16 in Safari, evicted oldest-first), and cold restore builds a
 * session for every persisted pane *including minimized doors*, which never
 * paint. Claiming contexts at create would spend the budget on invisible
 * surfaces and, because eviction is oldest-first and one-way, permanently
 * demote the earliest-restored panes.
 *
 * Falls back to the DOM renderer whenever WebGL is unavailable: no GL
 * context (headless/jsdom, blocklisted GPU) throws at construction, and
 * exceeding the browser's live-context budget fires `onContextLoss` later.
 * Both paths dispose the addon, which is xterm's documented signal to
 * resume DOM rendering — degraded, never broken.
 */
function tryEnableWebglRenderer(terminal: Terminal, host: HTMLElement): void {
  const markDom = () => host.setAttribute('data-renderer', 'dom');
  // Cheap pre-check so environments that could never succeed don't pay for a
  // doomed context request. jsdom in particular has no `getContext`, and
  // attempting one makes every terminal-creating unit test log a
  // "Not implemented" error through the virtual console.
  if (!cfg.terminal.webglRenderer || typeof WebGL2RenderingContext === 'undefined') {
    markDom();
    return;
  }
  let addon: WebglAddon;
  try {
    addon = new WebglAddon();
  } catch {
    markDom();
    return;
  }
  addon.onContextLoss(() => {
    addon.dispose();
    markDom();
  });
  try {
    terminal.loadAddon(addon);
    host.setAttribute('data-renderer', 'webgl');
  } catch {
    addon.dispose();
    markDom();
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
    cursorBlink: cfg.terminal.cursorBlink,
    theme,
    // kittyKeyboard disambiguates Shift+Enter from Enter for TUIs that read
    // raw VT (Claude Code everywhere; Codex on macOS/Linux). win32InputMode
    // covers Windows TUIs that read via the Console API behind ConPTY (Codex),
    // which can't negotiate the kitty protocol there: when conhost enables it
    // (CSI ? 9001 h), xterm sends faithful Win32 INPUT_RECORD key events so
    // Shift+Enter and Ctrl+J reach the app intact. Both are opt-in/negotiated,
    // so they coexist — each program turns on whichever it understands.
    vtExtensions: { kittyKeyboard: true, win32InputMode: IS_WINDOWS },
    linkHandler: {
      activate: (event, uri, range) => {
        event.preventDefault();
        // Closure capture: `terminal` is defined by the time a click fires.
        requestExternalLinkConfirmation(uri, readDisplayTextFromBuffer(terminal, range));
      },
      allowNonHttpProtocols: true,
    },
  });

  // Only hosts that can run workbench commands (the VS Code adapter) opt in;
  // on every other platform runWorkbenchCommand is undefined, so the chords
  // stay in xterm exactly as before.
  if (getPlatform().runWorkbenchCommand) {
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
    if (detail.id !== id) return;
    terminal.write(`\r\n[Process exited with code ${detail.exitCode}]\r\n`);
    // The PTY process is dead but the pane lingers in the registry; mark it so
    // the directory reports this surface as `alive: false` to the phone.
    const entry = registry.get(id);
    if (entry) entry.exited = true;
    // The process is gone, so any command we seeded for this pane is no longer
    // live; clear it so `dor ensure` stops matching a dead surface.
    finishLaunchedCommandByPtyId(id, detail.exitCode);
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

function setupTerminalEntry(id: string, options: { shell?: string; untouched?: boolean } = {}): TerminalEntry {
  const { terminal, fit, element } = createXtermHost();
  const selectionBaselineRef = { current: null as string | null };

  const disposePty = wirePtyEvents(id, terminal);
  const disposeXterm = wireXtermHandlers(id, terminal, selectionBaselineRef);
  const mouseModeObserver = attachMouseModeObserver(id, terminal);
  // Windows-only: keep win32-input-mode from clobbering kitty-protocol TUIs.
  // Off-Windows win32-input-mode is never advertised, so kitty already wins.
  const keyboardProtocolArbiter = IS_WINDOWS ? attachKeyboardProtocolArbiter(terminal) : null;
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
    keyboardProtocolArbiter?.dispose();
    cleanupMouseRouter();
  };

  const entry: TerminalEntry = {
    ptyId: id,
    shellKind: shellCommandKind(options.shell, PLATFORM_STRING),
    terminal,
    fit,
    element,
    cleanup,
    alertStatus: 'WATCHING_DISABLED',
    watchingEnabled: false,
    todo: false,
    notification: null,
    attentionDismissedRing: false,
    awaited: false,
    isReplaying: false,
    untouched: options.untouched ?? false,
  };

  const primed = consumePrimedActivity(id);
  if (primed) {
    if (primed.status !== undefined) entry.alertStatus = primed.status;
    if (primed.watchingEnabled !== undefined) entry.watchingEnabled = primed.watchingEnabled;
    if (primed.todo !== undefined) entry.todo = primed.todo;
    if (primed.notification !== undefined) entry.notification = primed.notification;
    if (primed.awaited !== undefined) entry.awaited = primed.awaited;
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

/** The parser family captured when this Session's PTY launched. */
export function getTerminalShellKind(id: string): ShellCommandKind | null {
  return registry.get(id)?.shellKind ?? null;
}

const LAUNCH_PROMPT_POLL_MS = 100;
const LAUNCH_PROMPT_TIMEOUT_MS = 15_000;
// `dor ensure` only types into a shell once OSC 633 integration is confirmed, on
// a tighter budget — and drops the command rather than blindly typing it into a
// shell that can never be tracked (see the requireIntegration branch below).
const INTEGRATION_TYPE_TIMEOUT_MS = 8_000;

// `dor split/ensure -- <command>` spawns a real interactive shell (see
// createSplitSurface) and types the command into it, rather than running
// `shell -c command`. That leaves a live shell behind the command, so
// `dor ensure --restart` can Ctrl+C the command and have the shell survive and
// return to a prompt instead of the whole pty exiting. But we must wait for the
// shell to actually reach a prompt first, or the keystrokes land in shell
// startup.
//
// `dor split` (requireIntegration=false): wait for any first prompt —
// seedLaunchedCommand primed currentCommand, which clears the moment the shell
// draws its first prompt (integration promptStart, or the keystroke heuristic
// for shells without it). On timeout we type anyway as best effort.
//
// `dor ensure` (requireIntegration=true): wait specifically for OSC 633 (the
// only signal that makes the surface trackable), and on timeout DROP the
// command. The ensure handler kills the surface and errors in that case, so a
// shell with no integration (e.g. cmd.exe) never half-runs an untrackable
// command.
function typeCommandWhenPromptReady(id: string, command: string, requireIntegration: boolean): void {
  const timeoutMs = requireIntegration ? INTEGRATION_TYPE_TIMEOUT_MS : LAUNCH_PROMPT_TIMEOUT_MS;
  let elapsed = 0;
  const timer = setInterval(() => {
    // A gone shell can't run anything. `exited` also covers a spawn that failed
    // outright (pty-core answers a spawn error with an exit), where the seeded
    // command has just been cleared and `ready` would otherwise read as true —
    // typing into a pty that never existed.
    const entry = registry.get(id);
    if (!entry || entry.exited) {
      clearInterval(timer);
      return;
    }
    const ready = requireIntegration
      ? isPaneOscDriven(id)
      : getTerminalPaneState(id).currentCommand === null;
    if (ready) {
      clearInterval(timer);
      getPlatform().writePty(id, `${command}\r`);
    } else if ((elapsed += LAUNCH_PROMPT_POLL_MS) >= timeoutMs) {
      clearInterval(timer);
      // Best effort for split; drop for ensure (the handler kills + errors).
      if (!requireIntegration) getPlatform().writePty(id, `${command}\r`);
    }
  }, LAUNCH_PROMPT_POLL_MS);
}

export function getOrCreateTerminal(id: string): TerminalEntry {
  const existing = registry.get(id);
  if (existing) return existing;

  const shellOpts = pendingShellOpts.get(id);
  pendingShellOpts.delete(id);
  const entry = setupTerminalEntry(id, {
    shell: shellOpts?.shell,
    untouched: shellOpts?.untouched ?? true,
  });
  resetTerminalPaneState(id);
  if (shellOpts?.title) {
    setTerminalUserTitle(id, shellOpts.title);
  }

  const dims = entry.fit.proposeDimensions();
  getPlatform().spawnPty(id, {
    cols: dims?.cols || 80,
    rows: dims?.rows || 30,
    shell: shellOpts?.shell,
    args: shellOpts?.args,
    cwd: shellOpts?.cwd,
  });
  if (shellOpts?.command) {
    seedLaunchedCommand(id, shellOpts.command, shellOpts.cwd);
    typeCommandWhenPromptReady(id, shellOpts.command, shellOpts.requireIntegration === true);
  }
  seedProcessCwdAfterSpawn(id);

  return entry;
}

export function resumeTerminal(
  id: string,
  replayData: string | null,
  exitInfo?: { alive: boolean; exitCode?: number; shell?: string; title?: string | null; untouched?: boolean },
): TerminalEntry {
  const existing = registry.get(id);
  if (existing) return existing;

  const entry = setupTerminalEntry(id, {
    shell: exitInfo?.shell,
    untouched: exitInfo?.untouched ?? false,
  });
  const isDead = exitInfo != null && !exitInfo.alive;

  if (replayData) {
    // Dead session: append the reset tail. A live resume leaves the modes to
    // the still-running process that owns them (see REPLAY_MODE_RESET).
    writeReplay(entry, replayData, ...(isDead ? [REPLAY_MODE_RESET] : []));
    seedPromptShapeFromScrollback(id, replayData);
  }
  if (isDead) {
    entry.terminal.write(`\r\n[Process exited with code ${exitInfo.exitCode ?? -1}]\r\n`);
    entry.exited = true;
  }
  const savedTitle = exitInfo?.title?.trim();
  if (savedTitle && savedTitle !== UNNAMED_PANEL_TITLE) {
    setTerminalUserTitle(id, savedTitle);
  }

  return entry;
}

// A cold restore never replays a transcript — scrollback is not persisted
// (docs/specs/transport.md -> "What is persisted"). What can come back is the
// agent the host interrupted on its way down, which this pane re-runs itself.
export function restoreTerminal(
  id: string,
  opts: { cwd?: string | null; title?: string | null; cwdWarning?: string | null; shell?: string; args?: string[]; untouched?: boolean; resumeCommand?: string | null },
): TerminalEntry {
  const existing = registry.get(id);
  if (existing) return existing;

  const entry = setupTerminalEntry(id, {
    shell: opts.shell,
    untouched: opts.untouched ?? false,
  });
  resetTerminalPaneState(id);
  seedTerminalManualCwd(id, opts.cwd);
  const trimmedTitle = opts.title?.trim();
  if (trimmedTitle && trimmedTitle !== UNNAMED_PANEL_TITLE) {
    setTerminalUserTitle(id, trimmedTitle);
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

  // Revalidated rather than trusted: the snapshot may have been written by an
  // older detector, and this string is about to be executed.
  const resume = opts.resumeCommand ? normalizeResumeCommand(opts.resumeCommand) : null;
  if (resume) {
    // A passive notice, not a dialog: the pane has no transcript, so without it
    // an agent simply appears. It also states the discontinuity the resume hides
    // — the interrupted turn did not continue.
    entry.terminal.write(`${DIM}⟲ resuming agent session: ${resume}${RESET}\r\n`);
    // Seeded before the write because this bypasses xterm's keystroke fallback,
    // and typed only once the fresh shell reaches a prompt — spawn-then-type is
    // exactly the window shell startup swallows keystrokes in.
    seedLaunchedCommand(id, resume, opts.cwd ?? undefined);
    typeCommandWhenPromptReady(id, resume, false);
  }

  return entry;
}

export function mountElement(id: string, container: HTMLElement): void {
  const entry = registry.get(id);
  if (!entry) return;
  container.appendChild(entry.element);
  // First paint is the earliest point worth claiming a GL context — see
  // `tryEnableWebglRenderer` on why create is too early.
  if (!entry.webglAttempted) {
    entry.webglAttempted = true;
    tryEnableWebglRenderer(entry.terminal, entry.element);
  }
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

/**
 * A non-terminal content surface's focus contract, so `focusSession` can drive
 * it like any xterm pane. The iframe surface registers one whose `focus` moves
 * keyboard focus into the instrumented frame (docs/specs/dor-browser.md →
 * "Iframe Focus And Rendering Notes").
 */
export interface SurfaceFocusHandle {
  focus(): void;
  blur(): void;
}

const surfaceFocusHandles = new Map<string, SurfaceFocusHandle>();

export function registerSurfaceFocusHandle(id: string, handle: SurfaceFocusHandle): () => void {
  surfaceFocusHandles.set(id, handle);
  return () => {
    if (surfaceFocusHandles.get(id) === handle) surfaceFocusHandles.delete(id);
  };
}

export function focusSession(id: string, focused: boolean): void {
  // Non-terminal surfaces (iframe) aren't in the xterm registry — route to
  // their focus handle so onClickPanel → enterTerminalMode focuses them too.
  const handle = surfaceFocusHandles.get(id);
  if (handle) {
    if (focused) handle.focus();
    else handle.blur();
    return;
  }

  const entry = registry.get(id);
  if (!entry) return;

  if (focused) {
    entry.terminal.focus();
  } else {
    entry.terminal.blur();
    getPlatform().alertClearAttention(entry.ptyId);
  }
}
