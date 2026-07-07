import { useRef, useState, useEffect, useCallback, useMemo, lazy, Suspense, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { Baseboard } from './Baseboard';
import { ExternalLinkModalHost } from './ExternalLinkModalHost';
import { AgentBrowserScreenModalHost } from './AgentBrowserScreenModalHost';
// Remote-host code (relay/WebSocket/enrollment + the window.dormouseRemoteHost
// console hook) is loaded and mounted only when the embedding runtime opts in
// via `enableRemoteHost` — see the mount below. Lazy so it stays out of the
// website playground and vscode webview bundles, which never enable it.
const RemotePairingModalHost = lazy(() =>
  import('../remote/host/RemotePairingModalHost').then((m) => ({
    default: m.RemotePairingModalHost,
  })),
);
import { getAgentBrowserScreenController } from './wall/agent-browser-screen';
import { markAgentBrowserSessionClosed } from './wall/agent-browser-sessions';
import { disposeAgentBrowserSurfaceController } from './wall/agent-browser-surface-controller';
import { KILL_CONFIRM_MS, KILL_SHAKE_MS, KillConfirmOverlay, randomKillChar, type ConfirmKill } from './KillConfirm';
import {
  clearSessionAttention,
  clearLocalSurfaceActivity,
  disposeSession,
  dismissOrToggleAlert,
  focusSession,
  markSessionAttention,
  toggleSessionTodo,
  setPendingShellOpts,
  getDefaultShellOpts,
  getTerminalPaneState,
  getTerminalPaneStateSnapshot,
  isPaneOscDriven,
  getActivitySnapshot,
  isUntouched,
  getOrCreateTerminal,
  getTerminalInstance,
  setTerminalUserTitle,
  UNNAMED_PANEL_TITLE,
  type SessionStatus,
} from '../lib/terminal-registry';
import {
  buildAppTitleResolver,
  createTerminalPaneState,
  deriveSurfaceLabel,
  surfaceRunsCommand,
  type TerminalPaneState,
} from '../lib/terminal-state';
import { getPlatform, PLATFORM_STRING } from '../lib/platform';
import type { DorControlRequestPayload, DorControlResult } from 'dor/protocol';
import { SURFACE_CONTROL_METHODS } from 'dor/protocol';
import type {
  Surface as DorSurface,
  SplitDirection as DorSplitDirection,
  ResolvedSplitDirection as DorResolvedSplitDirection,
  ParseResult,
  SurfaceType as DorSurfaceType,
} from 'dor/commands/types';
import { buildShellCommandForKind, shellCommandKind } from 'dor/commands/shell-quote';
import type { PersistedDoor } from '../lib/session-types';
import type { DropTarget, RestoreToken } from '../lib/lath/ops';
import type { Edge } from '../lib/lath/model';
import { useDynamicPalette } from '../lib/themes/use-dynamic-palette';
import { resolveRenderMode, isAgentBrowserParams, isBrowserParams } from './wall/browser-surface';
import { hostPathDisplay } from './wall/browser-url';
import { WorkspaceSelectionOverlay } from './wall/WorkspaceSelectionOverlay';
import { LathHost } from './wall/LathHost';
import {
  createLathWallEngine,
  terminalLeafMeta,
  browserLeafMeta,
  legacyTokenFromDoor,
  leafMetaFromDoor,
  dorDirectionForEdge,
  edgeForDorDirection,
  directionForArrow,
} from './wall/lath-wall-engine';
import type { WallNav } from './wall/keyboard/types';
import { useWallKeyboard } from './wall/use-wall-keyboard';
import { useSessionPersistence } from './wall/use-session-persistence';
import { useDevServerPortCorrelation } from './wall/use-dev-server-ports';
import { useWindowFocused } from './wall/use-window-focused';
import {
  DialogKeyboardContext,
  DoorElementsContext,
  ModeContext,
  PaneElementsContext,
  PaneWriteContext,
  WallActionsContext,
  RenamingIdContext,
  SelectedIdContext,
  WindowFocusedContext,
  ZoomedContext,
  type PaneWriteActions,
  type WallActions,
} from './wall/wall-context';
import type { DoorAfterRestoreAction, DooredItem, VisiblePane, WallEvent, WallMode, WallSelectionKind } from './wall/wall-types';

type ShellSpawnRequest = {
  shell?: string;
  args?: string[];
  name?: string;
  replaceUntouched?: boolean;
  announce?: boolean;
};

type ShellSpawnNoticeState = {
  id: string;
  text: string;
  nonce: number;
};

type DorControlParams = {
  command?: unknown;
  confirmation?: unknown;
  cwd?: unknown;
  direction?: unknown;
  input?: unknown;
  inputCount?: unknown;
  key?: unknown;
  lines?: unknown;
  minimized?: unknown;
  restart?: unknown;
  binaryPath?: unknown;
  pane?: string;
  session?: unknown;
  surface?: unknown;
  url?: unknown;
  workspace?: string;
  window?: string;
  scrollback?: unknown;
  wsPort?: unknown;
};

// The webview view of a control request: the shared wire payload, but with
// semantically-typed params and a `respond` callback the transport layer wires
// back to the request's `requestId`.
type DorControlRequest = Omit<DorControlRequestPayload, 'params'> & {
  params?: DorControlParams;
  respond: (response: DorControlResult) => void;
};

export type { DoorAfterRestoreAction, DooredItem, WallEvent, WallMode, WallSelectionKind } from './wall/wall-types';
export {
  DialogKeyboardContext,
  DoorElementsContext,
  ModeContext,
  WallActionsContext,
  RenamingIdContext,
  SelectedIdContext,
  WindowFocusedContext,
  ZoomedContext,
} from './wall/wall-context';
export type { WallActions } from './wall/wall-context';
export { MarchingAntsRect, roundedRectPath } from './wall/MarchingAntsRect';
export { TerminalPaneHeader } from './wall/TerminalPaneHeader';

function persistedPanelTitle(title: string | null | undefined): string {
  const trimmed = title?.trim();
  return trimmed || UNNAMED_PANEL_TITLE;
}

function surfaceTypeFromParams(params: unknown): DorSurfaceType {
  if (!isBrowserParams(params)) return 'terminal';
  // The CLI surface type tracks the *renderer* (iframe vs agent-browser) so
  // `dor` output stays informative even though both are one 'browser' surface.
  return resolveRenderMode(params) === 'iframe' ? 'iframe' : 'agent-browser';
}

/** Killing or swapping away from an agent-browser surface closes its session —
 *  surface lifetime and browser lifetime are bound (spec → Lifecycle). No-op
 *  for other surface types. */
function closeAgentBrowserSession(params: unknown): void {
  if (!isAgentBrowserParams(params)) return;
  const p = params as { session?: unknown; binaryPath?: unknown };
  if (typeof p.session !== 'string') return;
  const binaryPath = typeof p.binaryPath === 'string' ? p.binaryPath : undefined;
  // Mark before issuing the close so a popped-out surface's auto-revert sees
  // the impending teardown and doesn't relaunch the session we're killing.
  markAgentBrowserSessionClosed(p.session);
  getPlatform().agentBrowserCommand?.(p.session, ['close'], binaryPath).catch(() => {});
}

function componentForSurfaceType(type: DorSurfaceType): string {
  // iframe + agent-browser both render through the unified BrowserPanel.
  return type === 'terminal' ? 'terminal' : 'browser';
}

function tabComponentForSurfaceType(type: DorSurfaceType): string {
  return type === 'terminal' ? 'terminal' : 'surface';
}

function isSingletonWorkspaceTarget(target: string | undefined): boolean {
  return !target || target === 'workspace:1' || target === '1';
}

function isSingletonWindowTarget(target: string | undefined): boolean {
  return !target || target === 'window:1' || target === '1';
}

function matchesDorPaneTarget(target: string | undefined, surface: DorSurface): boolean {
  if (!target) return true;
  if (target === 'focused' || target === 'current') return surface.focused;
  if (target === surface.id || target === surface.ref || target === surface.paneRef) return true;

  const numeric = Number(target);
  return Number.isInteger(numeric) && numeric >= 1 && surface.index === numeric - 1;
}

function surfaceTitleTarget(target: string): string | null {
  return target.startsWith('title:') ? target.slice('title:'.length) : null;
}

function renderSurfaceForError(surface: DorSurface): string {
  return `${surface.ref} ${JSON.stringify(surface.title)}`;
}

function stringParam(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function booleanParam(value: unknown): boolean {
  return value === true;
}

function stringArrayParam(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return undefined;
  return value;
}

function numberParam(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function limitLines(text: string, lines: number | undefined): string {
  if (lines === undefined) return text;
  const parts = text.split('\n');
  return parts.slice(-lines).join('\n');
}

function readSurfaceText(surfaceId: string, lines: number | undefined, scrollback: boolean): string {
  const terminal = getTerminalInstance(surfaceId);
  if (!terminal) return '';

  // Read rendered text straight off the xterm buffer so both modes return clean,
  // ANSI-free lines and `--lines` trims by rendered line consistently. With
  // scrollback we walk the whole buffer (history + screen); otherwise just the
  // visible screen, which sits at `baseY..length`.
  const buffer = terminal.buffer.active;
  const start = scrollback ? 0 : Math.max(0, buffer.baseY);
  const end = buffer.length;
  const collected: string[] = [];
  for (let row = start; row < end; row += 1) {
    collected.push(buffer.getLine(row)?.translateToString(true) ?? '');
  }

  return limitLines(collected.join('\n').replace(/\n+$/, ''), lines);
}

// `dor ensure --restart` blocks the CLI while we interrupt a live command and
// re-run it. Rather than guess at timings, poll the integration-derived
// terminal state: a command is gone once `currentCommand` clears (commandFinish
// → prompt) and back once the surface reports the same command live again.
const RESTART_POLL_INTERVAL_MS = 100;
const RESTART_INTERRUPT_TIMEOUT_MS = 15_000;
const RESTART_START_TIMEOUT_MS = 15_000;

/** Resolve true once `predicate` holds for the surface's live state, false on timeout. */
function waitForTerminalState(
  id: string,
  predicate: (state: TerminalPaneState) => boolean,
  timeoutMs: number,
): Promise<boolean> {
  if (predicate(getTerminalPaneState(id))) return Promise.resolve(true);
  return new Promise((resolve) => {
    let elapsed = 0;
    const timer = setInterval(() => {
      if (predicate(getTerminalPaneState(id))) {
        clearInterval(timer);
        resolve(true);
      } else if ((elapsed += RESTART_POLL_INTERVAL_MS) >= timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, RESTART_POLL_INTERVAL_MS);
  });
}

/**
 * Restart a surface already running `command` in `cwd`: interrupt it (Ctrl+C),
 * wait for the shell to return to its prompt, type the command again, and wait
 * for it to go live. Drives the live PTY directly, so it works for minimized
 * doors too (their PTY keeps running). Returns a message on failure.
 */
async function restartSurfaceInPlace(id: string, command: string, cwd: string): Promise<ParseResult<undefined>> {
  // A match is by construction OSC-driven (surfaceRunsCommand only matches a
  // shell that reports its command), so this never fires on the real path — but
  // it guarantees we never fire Ctrl+C into a non-integration shell (e.g. cmd.exe
  // popping `Terminate batch job (Y/N)?`).
  if (!isPaneOscDriven(id)) return { ok: false, message: 'has no Dormouse shell integration to restart' };
  const platform = getPlatform();
  platform.writePty(id, '\x03');
  const interrupted = await waitForTerminalState(
    id,
    (state) => state.currentCommand === null,
    RESTART_INTERRUPT_TIMEOUT_MS,
  );
  if (!interrupted) return { ok: false, message: 'did not return to a prompt after interrupt' };
  platform.writePty(id, `${command}\r`);
  const restarted = await waitForTerminalState(
    id,
    (state) => surfaceRunsCommand(state, command, cwd),
    RESTART_START_TIMEOUT_MS,
  );
  if (!restarted) return { ok: false, message: 'command did not restart' };
  return { ok: true, value: undefined };
}

// A `dor ensure -- <command>` command is typed into the shell programmatically,
// which bypasses the keystroke heuristic — so only a shell whose integration
// emits OSC 633 boundaries ever reports the command back, which is what makes the
// surface matchable/restartable. `dor ensure` requires it. We give the shell this
// long to draw its first integrated prompt (headroom for a cold-start shell
// loading a profile / under AV) before concluding it has no integration.
const INTEGRATION_DETECT_TIMEOUT_MS = 8_000;

// Shown to the user (via the CLI's stderr) when `dor ensure` can't run because the
// target shell has no OSC 633 integration. `shell` is a display name when known.
function missingIntegrationError(shell?: string): string {
  const name = (shell ?? '').replace(/\\/g, '/').split('/').pop() || 'this shell';
  return `dor ensure requires OSC 633 shell integration, which ${name} does not provide. Run it from a shell with Dormouse integration, such as Git Bash or PowerShell.`;
}

function killConfirmationParam(value: unknown): { mode: 'if-read'; text: string } | { mode: 'dangerously' } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const confirmation = value as { mode?: unknown; text?: unknown };
  if (confirmation.mode === 'dangerously') return { mode: 'dangerously' };
  if (confirmation.mode === 'if-read' && typeof confirmation.text === 'string') {
    return { mode: 'if-read', text: confirmation.text };
  }
  return null;
}

function parseDorSplitDirection(value: unknown): DorSplitDirection | null {
  if (value === undefined || value === null) return 'auto';
  if (value === 'left' || value === 'right' || value === 'up' || value === 'down' || value === 'auto') return value;
  return null;
}

/**
 * Quote a raw argv into a single command string for the target pane's shell.
 * This is the one place the command is quoted; the CLI sends argv unquoted
 * precisely because only the webview knows which shell will run it.
 */
function dorCommandString(args: string[] | undefined): string | undefined {
  if (!args || args.join('').trim() === '') return undefined;
  const shell = getDefaultShellOpts()?.shell;
  return buildShellCommandForKind(shellCommandKind(shell, PLATFORM_STRING), args);
}

function ShellSpawnNotice({
  notice,
  paneElements,
  version,
}: {
  notice: ShellSpawnNoticeState | null;
  paneElements: Map<string, HTMLElement>;
  version: number;
}) {
  void version;
  if (!notice) return null;
  const target = paneElements.get(notice.id);
  if (!target) return null;
  const rect = target.getBoundingClientRect();
  return (
    <div
      key={notice.nonce}
      className="shell-spawn-notice pointer-events-none fixed z-[90] rounded border border-border bg-surface-raised px-2.5 py-1 font-mono text-xs text-foreground shadow-md"
      style={{
        top: rect.top + 38,
        left: rect.left + rect.width / 2,
        transform: 'translateX(-50%)',
      }}
    >
      {notice.text}
    </div>
  );
}

// --- Main component ---

export function Wall({
  initialPaneIds,
  initialMode = 'command',
  restoredLayout,
  restoredLathLayout,
  initialDoors,
  onEvent,
  baseboardNotice,
  showBaseboard = true,
  enableRemoteHost = false,
}: {
  initialPaneIds?: string[];
  initialMode?: WallMode;
  /** Legacy dockview layout blob from pre-Lath saves; migrated one-way to a Lath
   *  tree on seed (the upgrade channel). `restoredLathLayout` is preferred when
   *  present (docs/specs/tiling-engine.md → "Persistence and migration"). */
  restoredLayout?: unknown;
  /** The native Lath persisted layout, preferred over the legacy `restoredLayout`. */
  restoredLathLayout?: unknown;
  initialDoors?: PersistedDoor[];
  onEvent?: (event: WallEvent) => void;
  baseboardNotice?: ReactNode;
  showBaseboard?: boolean;
  /**
   * Opt in to the remote-control Host (the "Pocket" pairing seam). Only the
   * standalone desktop/sidecar runtime sets this; the website playground and
   * vscode webview leave it off so the remote-host stack and its
   * `window.dormouseRemoteHost` console hook never load there.
   */
  enableRemoteHost?: boolean;
} = {}) {
  // The Lath engine handle — Dormouse's tiling engine. Constructed once per Wall
  // mount (docs/specs/tiling-engine.md).
  const lath = useRef(createLathWallEngine()).current;
  const restoredLathLayoutRef = useRef(restoredLathLayout);

  // Pane ID generation (instance-scoped, not module-level)
  const paneCounterRef = useRef(0);
  const generatePaneId = useCallback(() => {
    return `pane-${(++paneCounterRef.current).toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
  }, []);

  const dialogKeyboardActiveRef = useRef(false);
  const setDialogKeyboardActive = useCallback((active: boolean) => {
    dialogKeyboardActiveRef.current = active;
  }, []);

  // Consumed once by the Lath seed effect to restore existing sessions
  const initialPaneIdsRef = useRef(initialPaneIds);
  const restoredLayoutRef = useRef(restoredLayout);
  const initialDoorsRef = useRef((initialDoors ?? []) as DooredItem[]);

  // Mutable maps shared via context — consumers must call bumpVersion() after
  // any mutation so that dependent effects/components re-run.
  const paneElementsRef = useRef(new Map<string, HTMLElement>());
  const paneElements = paneElementsRef.current;
  const [paneElementsVersion, setPaneElementsVersion] = useState(0);
  const doorElementsRef = useRef(new Map<string, HTMLElement>());
  const doorElements = doorElementsRef.current;
  const [doorElementsVersion, setDoorElementsVersion] = useState(0);
  const bumpPaneElementsVersion = useCallback(() => {
    setPaneElementsVersion((v) => v + 1);
  }, []);
  const bumpDoorElementsVersion = useCallback(() => {
    setDoorElementsVersion((v) => v + 1);
  }, []);

  // Selection/focus/mode policy lives here in the Wall; Lath owns only geometry.
  const [mode, setMode] = useState<WallMode>(initialMode);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<WallSelectionKind>('pane');

  const windowFocused = useWindowFocused();
  useDynamicPalette();

  // UI state
  const [confirmKill, setConfirmKill] = useState<ConfirmKill | null>(null);
  const [renamingPaneId, setRenamingPaneId] = useState<string | null>(null);
  const [doors, setDoors] = useState<DooredItem[]>(() => (initialDoors ?? []) as DooredItem[]);
  // The Door being dragged out of the baseboard: the item + the press point LathHost
  // starts its threshold-gated external drag from. Non-null feeds LathHost's
  // external-drag hit-testing; the chip stays in `doors` until it lands on a target.
  const [doorDrag, setDoorDrag] = useState<{ item: DooredItem; startX: number; startY: number } | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const [shellSpawnNotice, setShellSpawnNotice] = useState<ShellSpawnNoticeState | null>(null);
  const shellSpawnNoticeCounterRef = useRef(0);
  const shellSpawnNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Use refs so the capture-phase listener always sees latest state without re-registering
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const selectedTypeRef = useRef(selectedType);
  selectedTypeRef.current = selectedType;
  const doorsRef = useRef(doors);
  doorsRef.current = doors;
  const confirmKillRef = useRef(confirmKill);
  confirmKillRef.current = confirmKill;

  // The visible-pane projection (docs/specs/tiling-engine.md → "Pane props
  // contract"): the shared shape `buildDorSurfaces`, persistence, and the dev-server
  // correlation read — the tree's pre-order leaves + meta. A stable callback so the
  // hooks that depend on it never re-subscribe.
  const listVisiblePanes = useCallback((): VisiblePane[] => lath.listPanes(), [lath]);

  // The navigation/query seam for the keyboard handlers, backed by the engine.
  const nav = useMemo<WallNav>(() => ({
    ready: () => true,
    findInDirection: (id, dir) => lath.neighborOf(id, directionForArrow(dir)),
    paneParams: (id) => lath.getMeta(id)?.params,
    hasPane: (id) => lath.has(id),
    panes: () => listVisiblePanes().map((p) => p.id),
  }), [lath, listVisiblePanes]);
  const renamingRef = useRef(renamingPaneId);
  renamingRef.current = renamingPaneId;
  const shakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!confirmKill && shakeTimerRef.current) clearTimeout(shakeTimerRef.current);
  }, [confirmKill]);

  useEffect(() => () => {
    if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current);
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    if (shellSpawnNoticeTimerRef.current) clearTimeout(shellSpawnNoticeTimerRef.current);
  }, []);

  // --- External event notifications ---
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const fireEvent = useCallback((event: WallEvent) => {
    onEventRef.current?.(event);
  }, []);

  // Confirm runs the kill (its fade) concurrently with the letter flash so the
  // pane fade begins while the flash is still playing.
  const rejectKill = useCallback(() => {
    const ck = confirmKillRef.current;
    if (!ck || ck.exit) return;
    setConfirmKill({ ...ck, exit: 'shake' });
    shakeTimerRef.current = setTimeout(() => setConfirmKill(null), KILL_SHAKE_MS);
  }, []);

  useEffect(() => { onEventRef.current?.({ type: 'modeChange', mode }); }, [mode]);
  useEffect(() => { onEventRef.current?.({ type: 'zoomChange', zoomed }); }, [zoomed]);
  useEffect(() => { onEventRef.current?.({ type: 'minimizeChange', count: doors.length }); }, [doors]);
  useEffect(() => { onEventRef.current?.({ type: 'selectionChange', id: selectedId, kind: selectedType }); }, [selectedId, selectedType]);

  // --- Helpers ---

  /** Select a pane: the Wall state is the sole selection authority (Lath has no
   *  concept of selection/activation). */
  const selectPane = useCallback((id: string) => {
    selectedIdRef.current = id;
    selectedTypeRef.current = 'pane';
    setSelectedId(id);
    setSelectedType('pane');
  }, []);

  // The shared tail of both reattach paths (click-reattach + drag-out): drop the Door
  // chip from the baseboard and select the now-restored pane.
  const removeDoorAndSelect = useCallback((id: string) => {
    const nextDoors = doorsRef.current.filter(d => d.id !== id);
    doorsRef.current = nextDoors;
    setDoors(nextDoors);
    selectPane(id);
  }, [selectPane]);

  // Swap two panes' surfaces (Cmd-Arrow): swap leaf identities — meta and registry
  // entries follow ids, so there is no companion title swap.
  const swapWithNeighbor = useCallback((fromId: string, toId: string) => {
    lath.swapLeaves(fromId, toId);
  }, [lath]);

  // The selection tail of a surface-adding op. A non-focus-neutral add selects the
  // new pane; a focus-neutral add moves selection onto it only when it replaced the
  // pane the user was selected on.
  const settleAddSelection = useCallback((focusNeutral: boolean, selectionReplaced: boolean, newId: string): boolean => {
    if (!focusNeutral || selectionReplaced) { selectPane(newId); return true; }
    return false;
  }, [selectPane]);

  const showShellSpawnNotice = useCallback((id: string, text: string) => {
    if (shellSpawnNoticeTimerRef.current) {
      clearTimeout(shellSpawnNoticeTimerRef.current);
    }
    setShellSpawnNotice({
      id,
      text,
      nonce: ++shellSpawnNoticeCounterRef.current,
    });
    shellSpawnNoticeTimerRef.current = setTimeout(() => {
      setShellSpawnNotice(null);
      shellSpawnNoticeTimerRef.current = null;
    }, 1500);
  }, []);

  const killPaneImmediately = useCallback((id: string) => {
    // A second kill for a pane already mid-fade is a no-op (idempotent) — it must
    // not re-fire the event, re-dispose, or schedule a second removal.
    if (lath.isDying(id)) return;
    const isVisiblePane = nav.hasPane(id);
    if (!isVisiblePane) {
      // A doored surface has no visible pane but still owns a live session
      // (its PTY keeps running). `dor ensure --minimize`'s integration-timeout
      // teardown lands here: the throwaway was created straight into a door.
      const door = doorsRef.current.find(d => d.id === id);
      if (!door) return;
      closeAgentBrowserSession(door.params);
      disposeAgentBrowserSurfaceController(id);
      // Dispose the session/registry entry — this stops the PTY and makes a
      // still-armed typeCommandWhenPromptReady exit via its `!registry.has(id)`
      // check, so a late OSC signal can't type the command into a dead surface.
      disposeSession(id);
      const nextDoors = doorsRef.current.filter(d => d.id !== id);
      doorsRef.current = nextDoors;
      setDoors(nextDoors);
      // Guard: no current caller kills a selected door (ensure's throwaway is
      // never selected), but if one did, fall back to a visible pane.
      if (selectedIdRef.current === id && selectedTypeRef.current === 'door') {
        const survivorId = lath.listPanes()[0]?.id ?? null;
        if (survivorId) selectPane(survivorId);
        else setSelectedId(null);
      }
      clearLocalSurfaceActivity(id);
      fireEvent({ type: 'kill', id });
      return;
    }
    const params = nav.paneParams(id);
    closeAgentBrowserSession(params);
    // Release the surface's client-side controller (connection, loops, timers,
    // screen registration). A safe no-op for iframe/terminal surfaces.
    disposeAgentBrowserSurfaceController(id);
    // Two-phase kill (docs/specs/tiling-engine.md → "Animation"): fade the pane in
    // place (a last-pane kill also shrinks it toward the bottom-right), then commit
    // `remove` once the fade completes — survivors tween into the reclaimed space.
    // Dispose the session now so the content freezes under the fade. The restore
    // token is discarded (kills don't restore).
    const lastLeaf = lath.leafIds().length === 1;
    lath.markDying(id, { shrinkTowardBottomRight: lastLeaf });
    disposeSession(id);
    setTimeout(() => {
      if (!lath.has(id)) return; // superseded meanwhile (e.g. replaced)
      // Live re-read at removal time: only a kill of the still-selected pane moves
      // selection; navigating away mid-fade is honored. Removing the last leaf
      // empties the tree and the auto-spawn effect fills it.
      const wasSelectedPane = selectedTypeRef.current === 'pane' && selectedIdRef.current === id;
      lath.removeLeaf(id);
      if (wasSelectedPane) {
        const survivorId = lath.listPanes()[0]?.id ?? null;
        if (survivorId) selectPane(survivorId);
        else setSelectedId(null);
      }
    }, lath.exitMs);
    clearLocalSurfaceActivity(id);
    fireEvent({ type: 'kill', id });
  }, [fireEvent, selectPane, lath, nav]);

  const acceptKill = useCallback(() => {
    const ck = confirmKillRef.current;
    if (!ck || ck.exit) return;
    const staged = { ...ck, exit: 'confirm' as const };
    // Written to the ref synchronously, not just via setState: the ref otherwise
    // updates on the NEXT render, so a second confirm keydown arriving before
    // React flushes would pass this guard and kill the same pane twice. (Lath's
    // `isDying` guard in killPaneImmediately is the second line of defense.)
    confirmKillRef.current = staged;
    setConfirmKill(staged);
    killPaneImmediately(ck.id);
    confirmTimerRef.current = setTimeout(() => setConfirmKill(null), KILL_CONFIRM_MS);
  }, [killPaneImmediately]);

  /** Select a door in the baseboard */
  const selectDoor = useCallback((id: string) => {
    selectedIdRef.current = id;
    selectedTypeRef.current = 'door';
    setSelectedId(id);
    setSelectedType('door');
  }, []);

  /** Enter terminal mode for the given panel */
  const enterTerminalMode = useCallback((id: string) => {
    modeRef.current = 'passthrough';
    selectedIdRef.current = id;
    selectedTypeRef.current = 'pane';
    setSelectedId(id);
    setSelectedType('pane');
    setMode('passthrough');
    markSessionAttention(id);
    // Defer focus so it happens after the mousedown/click event finishes.
    requestAnimationFrame(() => focusSession(id, true));
  }, []);
  const enterTerminalModeRef = useRef(enterTerminalMode);
  enterTerminalModeRef.current = enterTerminalMode;

  /** Minimize a pane: remove the leaf (capturing its restore token) and add a Door. */
  const minimizePane = useCallback((id: string, opts?: { select?: boolean }) => {
    const meta = lath.getMeta(id);
    if (!meta) return;
    const surfaceType = surfaceTypeFromParams(meta.params);
    const { token } = lath.removeLeaf(id); // may auto-spawn if this was the last leaf
    if (!token) return;
    clearSessionAttention(id);
    // The core token is the restore payload (docs/specs/tiling-engine.md → "Restore
    // tokens"); the legacy `{neighborId, direction, remainingPaneIds, layoutAtMinimize}`
    // fields are omitted — only pre-Lath doors carry them, read-only for migration.
    const door: DooredItem = {
      id,
      title: persistedPanelTitle(meta.title),
      component: componentForSurfaceType(surfaceType),
      tabComponent: tabComponentForSurfaceType(surfaceType),
      params: meta.params,
      token,
    };

    const nextDoors = [...doorsRef.current, door];
    doorsRef.current = nextDoors;
    setDoors(nextDoors);

    // Keep the minimized session selected as a door so the user can track where it went.
    // A focus-neutral creation (`dor ensure --minimize`) opts out: it must leave the
    // caller's mode and selection untouched (see createSplitSurface's focusNeutral).
    if (opts?.select !== false) {
      modeRef.current = 'command';
      setMode('command');
      selectDoor(id);
    }
  }, [selectDoor, lath]);

  /** Exit terminal mode */
  const exitTerminalMode = useCallback(() => {
    modeRef.current = 'command';
    setMode('command');
    const id = selectedIdRef.current;
    if (id) focusSession(id, false);
  }, []);

  useEffect(() => {
    // An iframe surface taking focus blurs this window without backgrounding the
    // app (document.hasFocus() stays true). Only clear cross-session attention
    // on a real blur, else focusing an iframe wipes attention (spec → "#2").
    const handleBlur = () => {
      if (document.hasFocus()) return;
      clearSessionAttention();
    };
    window.addEventListener('blur', handleBlur);
    return () => window.removeEventListener('blur', handleBlur);
  }, []);

  // --- Lath seed + auto-spawn ---
  const lathSeededRef = useRef(false);
  // The leaf-id set as of the last commit, so the store subscription can fire
  // `paneAdded` for ids that just appeared (splits, dor surfaces, restores,
  // auto-spawn). Seeded here so the seed ids are NOT re-fired by the diff — they
  // are announced explicitly below (the initial adds).
  const prevLeafIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (lathSeededRef.current) return;
    lathSeededRef.current = true;

    // Restore doors.
    const restoredDoors = initialDoorsRef.current;
    doorsRef.current = restoredDoors;
    setDoors(restoredDoors);

    // Hydrate: prefer the native Lath layout, migrate a legacy dockview blob, else
    // fresh panes.
    const { paneIds, fresh } = lath.seed(
      restoredLathLayoutRef.current,
      restoredLayoutRef.current,
      initialPaneIdsRef.current,
      generatePaneId,
    );
    // Prime default-shell opts for the fresh path's generated ids (a no-op for
    // already-restored ids).
    if (fresh) {
      const defaults = getDefaultShellOpts();
      if (defaults?.shell) {
        for (const id of paneIds) setPendingShellOpts(id, { shell: defaults.shell, args: defaults.args });
      }
    }
    setSelectedId(paneIds[0] ?? null);
    // Announce the seeded panes and prime the diff set so the store subscription
    // only fires for ids added later (the seed's own commits predate its subscribe).
    prevLeafIdsRef.current = new Set(paneIds);
    for (const id of paneIds) fireEvent({ type: 'paneAdded', id });
  }, [lath, generatePaneId, fireEvent]);

  // Auto-spawn: whenever a commit empties the tree (last pane killed/minimized),
  // spawn one to keep a pane visible — the Wall's "always one pane" rule.
  useEffect(() => {
    return lath.store.subscribe(() => {
      const snap = lath.store.getSnapshot();
      // Zoom truth: the store owns `zoomedId` (and clears it when a kill/replace
      // removes the zoomed leaf), so mirror the Wall's `zoomed` boolean off it.
      // setZoomed no-ops when unchanged, so this is cheap on every commit.
      setZoomed(snap.zoomedId !== null);
      // `paneAdded` for any leaf new since the last commit. Runs post-commit, so the
      // pane exists. Meta/zoom/resize commits leave the id set unchanged (no fire).
      // The auto-spawn below commits re-entrantly, so its new leaf is caught here too.
      const currentIds = lath.leafIds();
      const prevIds = prevLeafIdsRef.current;
      let leavesChanged = currentIds.length !== prevIds.size;
      for (const id of currentIds) {
        if (!prevIds.has(id)) {
          leavesChanged = true;
          fireEvent({ type: 'paneAdded', id });
        }
      }
      // The size check also catches pure removals, purging dead ids so a later
      // re-add of the same id fires again.
      if (leavesChanged) prevLeafIdsRef.current = new Set(currentIds);
      if (snap.tree.root !== null) return;
      const id = generatePaneId();
      const defaults = getDefaultShellOpts();
      if (defaults?.shell) setPendingShellOpts(id, { shell: defaults.shell, args: defaults.args });
      lath.setEnterHint(id, 'top-left'); // grows from the top-left as the killed pane shrank to the bottom-right
      lath.addLeaf(id, terminalLeafMeta(), null); // becomes the root
      // Adopt selection only when it points at nothing real: null, or dangling (a
      // just-killed pane). A live door (last pane minimized) keeps selection.
      const sel = selectedIdRef.current;
      const selDangling = sel !== null && selectedTypeRef.current === 'pane' && !lath.has(sel);
      if (sel === null || selDangling) selectPane(id);
    });
  }, [lath, generatePaneId, selectPane, fireEvent]);

  // --- Session persistence ---
  useSessionPersistence({
    lath,
    listVisiblePanes,
    doorsRef,
    selectedIdRef,
    selectedTypeRef,
  });

  // --- Dev-server port → pane correlation (browser header connection chip) ---
  useDevServerPortCorrelation({ listVisiblePanes, doorsRef });

  // --- Reattach ---

  const handleReattach = useCallback((
    item: DooredItem,
    options?: { enterPassthrough?: boolean; afterRestore?: DoorAfterRestoreAction },
  ) => {
    const enterPassthrough = options?.enterPassthrough ?? true;
    const afterRestore = options?.afterRestore;

    // Restore through the core token (the real payload): exact tier when the
    // captured context survives, else neighbor, else fallback beside a live ref.
    // A pre-Lath door has no token — synthesize a neighbor-tier one from its
    // {neighborId, direction} so it restores beside its old neighbor.
    const meta = leafMetaFromDoor(item);
    const token = (item.token as RestoreToken | undefined) ?? legacyTokenFromDoor(item);
    // The enter hint (from the token's edge) is derived inside `restoreLeaf`.
    const sel = selectedIdRef.current;
    const fallbackRef = sel && selectedTypeRef.current === 'pane' && lath.has(sel)
      ? sel
      : lath.listPanes()[0]?.id;
    const r = lath.restoreLeaf(meta, token, { fallbackRef });
    // `!ok` means no fallback was possible (empty tree) — make the leaf the root.
    if (!r.ok) lath.addLeaf(item.id, meta, null);

    removeDoorAndSelect(item.id);
    if (enterPassthrough) {
      enterTerminalMode(item.id);
    } else {
      modeRef.current = 'command';
      setMode('command');
      requestAnimationFrame(() => {
        // Guard against removal between scheduling and execution.
        if (!nav.hasPane(item.id)) return;
        focusSession(item.id, false);
        if (afterRestore === 'kill-immediately') {
          killPaneImmediately(item.id);
        } else if (afterRestore === 'confirm-kill') {
          setConfirmKill({ id: item.id, char: randomKillChar() });
        } else if (typeof afterRestore === 'object' && afterRestore.type === 'replace-terminal') {
          // Atomic identity swap in place — no transient add/remove.
          lath.replaceLeaf(item.id, afterRestore.newId, terminalLeafMeta());
          disposeSession(item.id);
          selectPane(afterRestore.newId);
          if (afterRestore.announce) {
            showShellSpawnNotice(afterRestore.newId, `Switched to ${afterRestore.shellName}`);
          }
        }
      });
    }
  }, [selectPane, removeDoorAndSelect, enterTerminalMode, killPaneImmediately, showShellSpawnNotice, lath, nav]);
  const handleReattachRef = useRef(handleReattach);
  handleReattachRef.current = handleReattach;

  // The visible panes + the active/selected surface. The "active" surface is
  // simply the selected pane.
  const buildDorSurfaces = useCallback((): DorSurface[] => {
    const panels = listVisiblePanes();
    const activeId = selectedTypeRef.current === 'pane' ? selectedIdRef.current : null;
    const terminalStates = getTerminalPaneStateSnapshot();
    const activityStates = getActivitySnapshot();
    const appTitleForPane = buildAppTitleResolver(terminalStates, activityStates);
    const panelStates = panels.map((panel) => terminalStates.get(panel.id) ?? createTerminalPaneState());

    return panels.map((panel, index) => {
      const type = surfaceTypeFromParams(panel.params);
      const state = panelStates[index] ?? createTerminalPaneState();
      const title = type === 'terminal'
        ? deriveSurfaceLabel(state, panelStates, appTitleForPane, panel.title ?? panel.id)
        : (panel.title ?? panel.id);

      return {
        id: panel.id,
        ref: `surface:${index + 1}`,
        paneRef: `pane:${index + 1}`,
        type,
        title,
        focused: panel.id === activeId,
        index,
        indexInPane: 0,
        requestedWorkingDirectory: type === 'terminal' ? (state.cwd?.path ?? null) : null,
        selectedInPane: true,
      };
    });
  }, [listVisiblePanes]);

  const surfaceRefForId = useCallback((id: string): string => {
    const panes = listVisiblePanes();
    const panelIndex = panes.findIndex((panel) => panel.id === id);
    if (panelIndex >= 0) return `surface:${panelIndex + 1}`;
    const doorIndex = doorsRef.current.findIndex((door) => door.id === id);
    if (doorIndex >= 0) return `surface:${panes.length + doorIndex + 1}`;
    return id;
  }, [listVisiblePanes]);

  const resolveVisibleSurface = useCallback((
    target: string | undefined,
    callerSurfaceId: string | undefined,
  ): ParseResult<DorSurface> => {
    const surfaces = buildDorSurfaces();
    const resolvedTarget = target ?? callerSurfaceId ?? 'focused';
    const titleTarget = surfaceTitleTarget(resolvedTarget);
    if (titleTarget !== null) {
      const matches = surfaces.filter((surface) => surface.title === titleTarget);
      if (matches.length === 1) return { ok: true, value: matches[0] };
      if (matches.length > 1) {
        return {
          ok: false,
          message: `surface target '${resolvedTarget}' matched multiple surfaces: ${matches.map(renderSurfaceForError).join(', ')}`,
        };
      }
      return { ok: false, message: `surface target '${resolvedTarget}' was not found` };
    }

    const matched = surfaces.find((surface) => matchesDorPaneTarget(resolvedTarget, surface))
      ?? (!target && !callerSurfaceId ? (surfaces[0] ?? null) : null);
    if (matched) return { ok: true, value: matched };
    return { ok: false, message: `surface '${resolvedTarget}' was not found` };
  }, [buildDorSurfaces]);

  const findSurfaceIdRunningCommand = useCallback((command: string, cwdPath: string): string | null => {
    const ids = [
      ...listVisiblePanes().map((panel) => panel.id),
      ...doorsRef.current.map((door) => door.id),
    ];
    return ids.find((id) => surfaceRunsCommand(getTerminalPaneState(id), command, cwdPath)) ?? null;
  }, [listVisiblePanes]);

  const createSplitSurface = useCallback(({
    command,
    direction,
    minimized,
    referenceId,
    cwd,
    requireIntegration,
    focusNeutral,
  }: {
    command?: string;
    direction: DorResolvedSplitDirection;
    minimized: boolean;
    referenceId: string;
    cwd?: string;
    requireIntegration?: boolean;
    // `dor ensure` must never move focus: the split is created in the background,
    // leaving the caller's selection, mode, and DOM focus intact. Under Lath every
    // add is inherently background (nothing re-parents or activates).
    focusNeutral?: boolean;
  }): ParseResult<{
    id: string;
    ref: string;
  }> => {
    const referenceVisible = nav.hasPane(referenceId);
    if (!referenceVisible) return { ok: false, message: `surface '${referenceId}' is not visible` };

    const newId = generatePaneId();
    const defaults = getDefaultShellOpts();
    // An explicit cwd (dor ensure --cwd, defaulting to the caller's directory)
    // wins; otherwise inherit the reference pane's local cwd as dor split does.
    const sourceCwd = getTerminalPaneState(referenceId).cwd;
    const inheritedCwd = cwd ?? (sourceCwd && !sourceCwd.isRemote ? sourceCwd.path : undefined);

    if (command) {
      // Spawn a real interactive shell and type the command into it once it
      // reaches a prompt (see typeCommandWhenPromptReady in the lifecycle), rather
      // than launching `shell -c command`. A `-c` invocation has no prompt behind
      // it: the command *is* the shell's whole job, so `dor ensure --restart`'s
      // Ctrl+C would interrupt the command and take the shell down with it (the
      // pty exits) instead of returning to a prompt the command can be re-run at.
      setPendingShellOpts(newId, {
        shell: defaults?.shell,
        args: defaults?.args,
        cwd: inheritedCwd,
        untouched: false,
        command,
        ...(requireIntegration ? { requireIntegration: true } : {}),
      });
    } else if (defaults?.shell || inheritedCwd) {
      setPendingShellOpts(newId, {
        shell: defaults?.shell,
        args: defaults?.args,
        cwd: inheritedCwd,
      });
    }

    // The split is inherently background: `dor split` (not focus-neutral) selects
    // the new pane; `dor ensure` (focus-neutral) leaves selection put.
    const edge = edgeForDorDirection(direction);
    lath.addLeaf(newId, terminalLeafMeta(), { refId: referenceId, edge });
    const selectedNew = settleAddSelection(!!focusNeutral, false, newId);
    onEventRef.current?.({
      type: 'split',
      direction: direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical',
      source: 'dor',
    });
    if (minimized) {
      getOrCreateTerminal(newId);
      minimizePane(newId, { select: selectedNew });
    }
    return { ok: true, value: { id: newId, ref: surfaceRefForId(newId) } };
  }, [generatePaneId, minimizePane, surfaceRefForId, lath, settleAddSelection, nav]);

  /**
   * Create a non-terminal content surface (iframe, agent-browser) next to a
   * reference surface: an untouched terminal caller is replaced in place,
   * anything else gets a split (the `dor iframe` placement rule).
   */
  const createContentSurface = useCallback(({
    minimized,
    params,
    reference,
    title,
    focusNeutral,
  }: {
    minimized: boolean;
    params: Record<string, unknown>;
    reference: DorSurface;
    title: string;
    // `dor iframe` / `dor ab` pass this to open the surface in the background
    // without moving focus off the caller, matching `dor ensure`.
    focusNeutral?: boolean;
  }): ParseResult<{
    id: string;
    ref: string;
    status: 'created' | 'replaced';
  }> => {
    const referenceVisible = nav.hasPane(reference.id);
    if (!referenceVisible) return { ok: false, message: `surface '${reference.ref}' is not visible` };

    const newId = generatePaneId();
    const browserMeta = browserLeafMeta(title, params);
    const replaceUntouchedTerminal = reference.type === 'terminal' && isUntouched(reference.id);

    if (replaceUntouchedTerminal) {
      // Whether the user's current selection sits on the pane being replaced.
      const selectionReplaced = selectedTypeRef.current === 'pane' && selectedIdRef.current === reference.id;
      // Atomic identity swap in place; then dispose the old terminal session.
      lath.replaceLeaf(reference.id, newId, browserMeta);
      disposeSession(reference.id);
      // Replacing the pane the user is selected on forces selection onto the
      // replacement; replacing any other pane leaves the user's selection —
      // including a door selection — untouched.
      const selectedNew = settleAddSelection(!!focusNeutral, selectionReplaced, newId);
      // When we did move selection onto the new pane, a minimize must carry it
      // onto the resulting door rather than leave selectedType='pane' pointing
      // at a door id (the overlay would keep a stale rect).
      if (minimized) minimizePane(newId, { select: selectedNew });
      return { ok: true, value: { id: newId, ref: surfaceRefForId(newId), status: 'replaced' } };
    }

    // Split beside the reference by its aspect ratio (autoEdge). The split-event
    // direction derives from it.
    const lathEdge = lath.autoEdgeFor(reference.id);
    const horizontal = lathEdge === 'right';
    lath.addLeaf(newId, browserMeta, { refId: reference.id, edge: lathEdge });
    const selectedNew = settleAddSelection(!!focusNeutral, false, newId);
    onEventRef.current?.({
      type: 'split',
      direction: horizontal ? 'horizontal' : 'vertical',
      source: 'dor',
    });
    if (minimized) minimizePane(newId, { select: selectedNew });
    return { ok: true, value: { id: newId, ref: surfaceRefForId(newId), status: 'created' } };
  }, [generatePaneId, minimizePane, surfaceRefForId, lath, settleAddSelection, nav]);

  // The last binary path a `dor ab` surface resolved on a terminal's PATH.
  // Re-used to spawn an agent-browser when swapping an iframe embed up to a
  // screencast, since the webview/host PATH may not find the binary itself.
  const lastAgentBrowserBinaryPathRef = useRef<string | undefined>(undefined);

  /**
   * Replace a content surface's renderer in place, preserving its slot
   * (docs/specs/dor-browser.md → "Display Modal And Render Swaps"): an atomic
   * identity swap that closes the old surface's session if any and selects the new.
   * The generalized form of createContentSurface's replace-untouched-terminal branch.
   */
  const replaceSurface = useCallback((oldId: string, next: {
    params: Record<string, unknown>;
    title: string;
  }): string | null => {
    const oldParams = nav.paneParams(oldId);
    const oldVisible = nav.hasPane(oldId);
    if (!oldVisible) return null;
    closeAgentBrowserSession(oldParams);
    // The old renderer's controller is going away with this swap; release its
    // client-side resources (no-op for a non-agent-browser surface).
    disposeAgentBrowserSurfaceController(oldId);
    const newId = generatePaneId();
    lath.replaceLeaf(oldId, newId, browserLeafMeta(next.title, next.params));
    clearLocalSurfaceActivity(oldId);
    selectPane(newId);
    return newId;
  }, [generatePaneId, selectPane, lath, nav]);

  /**
   * The agent-browser session ↔ surface registry, derived from panel/door
   * params rather than kept as separate state so it survives webview reloads.
   * Returns the surface bound to `session`, or null if none exists.
   */
  const findAgentBrowserSurface = useCallback((session: string): { id: string; minimized: boolean } | null => {
    const isMatch = (params: unknown) =>
      isAgentBrowserParams(params) && (params as { session?: unknown }).session === session;

    const panel = listVisiblePanes().find((candidate) => isMatch(candidate.params));
    if (panel) return { id: panel.id, minimized: false };
    const door = doorsRef.current.find((candidate) => isMatch(candidate.params));
    if (door) return { id: door.id, minimized: true };
    return null;
  }, [listVisiblePanes]);

  // Listen for external "new terminal" requests (e.g. from the standalone AppBar)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = ((e as CustomEvent<ShellSpawnRequest>).detail ?? {}) as ShellSpawnRequest;
      const newId = generatePaneId();

      // Store shell options so getOrCreateTerminal picks them up on mount
      if (detail?.shell) {
        setPendingShellOpts(newId, { shell: detail.shell, args: detail.args });
      }

      const selectedPaneId = selectedTypeRef.current === 'pane' ? selectedIdRef.current : null;
      const selectedPaneVisible = !!selectedPaneId && nav.hasPane(selectedPaneId);
      const selectedDoor = selectedTypeRef.current === 'door'
        ? doorsRef.current.find((door) => door.id === selectedIdRef.current)
        : undefined;
      const shouldReplaceUntouched =
        detail.replaceUntouched === true &&
        selectedPaneVisible &&
        isUntouched(selectedPaneId!);
      const shellName = detail.name?.trim() || 'terminal';

      if (shouldReplaceUntouched) {
        lath.replaceLeaf(selectedPaneId!, newId, terminalLeafMeta());
        disposeSession(selectedPaneId!);
        selectPane(newId);
        if (detail.announce) {
          showShellSpawnNotice(newId, `Switched to ${shellName}`);
        }
        return;
      }

      if (detail.replaceUntouched === true && selectedDoor && isUntouched(selectedDoor.id)) {
        handleReattachRef.current(selectedDoor, {
          enterPassthrough: false,
          afterRestore: {
            type: 'replace-terminal',
            newId,
            shellName,
            announce: detail.announce === true,
          },
        });
        return;
      }

      // Split beside the selected pane when it's a live pane, else `null` lets the
      // store fall back to the last leaf via autoEdge (its null-position behavior).
      const edge = selectedPaneVisible ? lath.autoEdgeFor(selectedPaneId!) : null;
      // The enter hint is derived inside `addLeaf` from the edge it commits.
      lath.addLeaf(newId, terminalLeafMeta(), edge ? { refId: selectedPaneId!, edge } : null);
      selectPane(newId);
      if (detail.announce) {
        showShellSpawnNotice(newId, `Opened ${shellName}`);
      }
    };
    window.addEventListener('dormouse:new-terminal', handler);
    return () => window.removeEventListener('dormouse:new-terminal', handler);
  }, [generatePaneId, selectPane, showShellSpawnNotice, lath, nav]);

  useEffect(() => {
    const handler = async (event: Event) => {
      const detail = (event as CustomEvent<DorControlRequest>).detail;
      if (!detail) return;

      const params = detail.params ?? {};
      if (!isSingletonWorkspaceTarget(params.workspace)) {
        detail.respond({ ok: false, error: `unsupported workspace target '${params.workspace}'` });
        return;
      }
      if (!isSingletonWindowTarget(params.window)) {
        detail.respond({ ok: false, error: `unsupported window target '${params.window}'` });
        return;
      }

      // Resolve the split reference surface and confirm it is a live visible pane,
      // responding with the appropriate error and returning null otherwise.
      const resolveSplitTarget = () => {
        const target = resolveVisibleSurface(stringParam(params.surface), detail.surfaceId);
        if (!target.ok) {
          detail.respond({ ok: false, error: target.message });
          return null;
        }
        const visible = nav.hasPane(target.value.id);
        if (!visible) {
          detail.respond({ ok: false, error: `surface '${target.value.ref}' is not visible` });
          return null;
        }
        return { target: target.value };
      };

      // The `direction: 'auto'` aspect-ratio split resolution.
      const autoDorDirection = (id: string): DorResolvedSplitDirection =>
        dorDirectionForEdge(lath.autoEdgeFor(id));

      if (detail.method === SURFACE_CONTROL_METHODS.list) {
        const surfaces = buildDorSurfaces();
        detail.respond({
          ok: true,
          result: {
            surfaces: surfaces.filter((surface) => matchesDorPaneTarget(params.pane, surface)),
            workspaceRef: 'workspace:1',
            windowRef: 'window:1',
          },
        });
        return;
      }

      if (detail.method === SURFACE_CONTROL_METHODS.split) {
        const directionParam = parseDorSplitDirection(params.direction);
        if (!directionParam) {
          detail.respond({ ok: false, error: `invalid split direction '${String(params.direction)}'` });
          return;
        }
        const resolved = resolveSplitTarget();
        if (!resolved) return;
        const direction = directionParam === 'auto'
          ? autoDorDirection(resolved.target.id)
          : directionParam;
        const command = dorCommandString(stringArrayParam(params.command));
        if (params.command !== undefined && !command) {
          detail.respond({ ok: false, error: 'command cannot be empty' });
          return;
        }
        const result = createSplitSurface({
          command,
          direction,
          minimized: booleanParam(params.minimized),
          referenceId: resolved.target.id,
        });
        if (!result.ok) {
          detail.respond({ ok: false, error: result.message });
          return;
        }
        detail.respond({
          ok: true,
          result: {
            status: 'created',
            surfaceId: result.value.id,
            surfaceRef: result.value.ref,
            direction,
            minimized: booleanParam(params.minimized),
            ...(command ? { command } : {}),
          },
        });
        return;
      }

      if (detail.method === SURFACE_CONTROL_METHODS.ensure) {
        const command = dorCommandString(stringArrayParam(params.command));
        if (!command) {
          detail.respond({ ok: false, error: 'command cannot be empty' });
          return;
        }
        const cwd = stringParam(params.cwd)?.trim();
        if (!cwd) {
          detail.respond({ ok: false, error: 'cwd is required' });
          return;
        }
        const existingId = findSurfaceIdRunningCommand(command, cwd);
        if (existingId) {
          const minimized = doorsRef.current.some((door) => door.id === existingId);
          if (booleanParam(params.restart)) {
            const restarted = await restartSurfaceInPlace(existingId, command, cwd);
            if (!restarted.ok) {
              detail.respond({ ok: false, error: `surface '${surfaceRefForId(existingId)}' ${restarted.message}` });
              return;
            }
            detail.respond({
              ok: true,
              result: {
                status: 'restarted',
                surfaceId: existingId,
                surfaceRef: surfaceRefForId(existingId),
                command,
                cwd,
                minimized,
              },
            });
            return;
          }
          detail.respond({
            ok: true,
            result: {
              status: 'existing',
              surfaceId: existingId,
              surfaceRef: surfaceRefForId(existingId),
              command,
              cwd,
              minimized,
            },
          });
          return;
        }
        // ensure needs OSC 633 to track the command. cmd.exe provably has none,
        // so when the configured shell is explicitly cmd, fail immediately without
        // even spawning a split. Only short-circuit on an explicit shell — an
        // unset shell classifies as 'cmd' on Windows but the sidecar may actually
        // spawn PowerShell, so let those fall through to the generic OSC wait.
        const ensureShell = getDefaultShellOpts()?.shell;
        if (ensureShell && shellCommandKind(ensureShell, PLATFORM_STRING) === 'cmd') {
          detail.respond({ ok: false, error: missingIntegrationError(ensureShell) });
          return;
        }
        const resolved = resolveSplitTarget();
        if (!resolved) return;
        const direction = autoDorDirection(resolved.target.id);
        const result = createSplitSurface({
          command,
          direction,
          minimized: booleanParam(params.minimized),
          referenceId: resolved.target.id,
          cwd,
          requireIntegration: true,
          // ensure never steals focus from the caller, matched or freshly created.
          focusNeutral: true,
        });
        if (!result.ok) {
          detail.respond({ ok: false, error: result.message });
          return;
        }
        // ensure is only useful if the new shell reports OSC 633 — otherwise it
        // can never be matched or restarted. A non-cmd shell can still lack
        // integration (misconfigured, exotic); wait for the signal, and if it
        // never arrives kill the throwaway split and fail cleanly rather than
        // half-run an untrackable command. typeCommandWhenPromptReady drops the
        // command in the same case, so nothing executes.
        const integrated = await waitForTerminalState(
          result.value.id,
          () => isPaneOscDriven(result.value.id),
          INTEGRATION_DETECT_TIMEOUT_MS,
        );
        if (!integrated) {
          // Tear down the throwaway split. The focus-neutral create never selected
          // it, so the kill's live selection check leaves the caller's selection
          // where ensure found it. A `--minimize` create is already a door;
          // killPaneImmediately tears the door down too — disposing the session and
          // removing it from the baseboard.
          killPaneImmediately(result.value.id);
          detail.respond({ ok: false, error: missingIntegrationError(ensureShell) });
          return;
        }
        detail.respond({
          ok: true,
          result: {
            status: 'created',
            surfaceId: result.value.id,
            surfaceRef: result.value.ref,
            command,
            cwd,
            minimized: booleanParam(params.minimized),
          },
        });
        return;
      }

      if (detail.method === SURFACE_CONTROL_METHODS.send) {
        const input = stringParam(params.input);
        if (input === undefined) {
          detail.respond({ ok: false, error: 'input is required' });
          return;
        }
        const target = resolveVisibleSurface(stringParam(params.surface), detail.surfaceId);
        if (!target.ok) {
          detail.respond({ ok: false, error: target.message });
          return;
        }
        if (target.value.type !== 'terminal') {
          detail.respond({ ok: false, error: `surface '${target.value.ref}' is not a terminal` });
          return;
        }
        getPlatform().writePty(target.value.id, input);
        detail.respond({
          ok: true,
          result: {
            status: 'sent',
            surfaceId: target.value.id,
            surfaceRef: target.value.ref,
            inputCount: typeof params.inputCount === 'number' ? params.inputCount : 1,
          },
        });
        return;
      }

      if (detail.method === SURFACE_CONTROL_METHODS.read) {
        const target = resolveVisibleSurface(stringParam(params.surface), detail.surfaceId);
        if (!target.ok) {
          detail.respond({ ok: false, error: target.message });
          return;
        }
        if (target.value.type !== 'terminal') {
          detail.respond({ ok: false, error: `surface '${target.value.ref}' is not a terminal` });
          return;
        }
        const lines = numberParam(params.lines);
        const scrollback = booleanParam(params.scrollback);
        const text = readSurfaceText(target.value.id, lines, scrollback);
        detail.respond({
          ok: true,
          result: {
            workspaceRef: 'workspace:1',
            surfaceId: target.value.id,
            surfaceRef: target.value.ref,
            text,
          },
        });
        return;
      }

      if (detail.method === SURFACE_CONTROL_METHODS.kill) {
        const confirmation = killConfirmationParam(params.confirmation);
        if (!confirmation) {
          detail.respond({ ok: false, error: 'invalid kill confirmation' });
          return;
        }
        const surface = stringParam(params.surface);
        if (!surface) {
          detail.respond({ ok: false, error: 'surface is required' });
          return;
        }
        const target = resolveVisibleSurface(surface, detail.surfaceId);
        if (!target.ok) {
          detail.respond({ ok: false, error: target.message });
          return;
        }
        if (confirmation.mode === 'if-read') {
          const text = readSurfaceText(target.value.id, undefined, false);
          if (!text.includes(confirmation.text)) {
            detail.respond({ ok: false, error: `surface '${target.value.ref}' read text did not contain confirmation text` });
            return;
          }
        }
        killPaneImmediately(target.value.id);
        detail.respond({
          ok: true,
          result: {
            status: 'killed',
            surfaceId: target.value.id,
            surfaceRef: target.value.ref,
          },
        });
        return;
      }

      if (detail.method === SURFACE_CONTROL_METHODS.iframe) {
        const url = stringParam(params.url);
        if (!url) {
          detail.respond({ ok: false, error: 'url is required' });
          return;
        }
        const target = resolveVisibleSurface(stringParam(params.surface), detail.surfaceId);
        if (!target.ok) {
          detail.respond({ ok: false, error: target.message });
          return;
        }
        const result = createContentSurface({
          minimized: booleanParam(params.minimized),
          params: { surfaceType: 'browser', renderMode: 'iframe', url },
          reference: target.value,
          title: hostPathDisplay(url, true),
          // `dor iframe` opens the embed in the background; caller keeps focus.
          focusNeutral: true,
        });
        if (!result.ok) {
          detail.respond({ ok: false, error: result.message });
          return;
        }
        detail.respond({
          ok: true,
          result: {
            status: result.value.status,
            surfaceId: result.value.id,
            surfaceRef: result.value.ref,
            url,
            minimized: booleanParam(params.minimized),
          },
        });
        return;
      }

      if (detail.method === SURFACE_CONTROL_METHODS.agentBrowser) {
        const session = stringParam(params.session);
        if (!session) {
          detail.respond({ ok: false, error: 'session is required' });
          return;
        }
        const key = stringParam(params.key);
        const wsPort = numberParam(params.wsPort);
        const binaryPath = stringParam(params.binaryPath);
        // Remember the resolved binary so an embed→screencast swap can spawn one.
        if (binaryPath) lastAgentBrowserBinaryPathRef.current = binaryPath;
        const refreshedParams = {
          ...(wsPort !== undefined ? { wsPort } : {}),
          ...(binaryPath !== undefined ? { binaryPath } : {}),
        };

        const existing = findAgentBrowserSurface(session);
        if (existing) {
          // Reuse: refresh the stream port (OS-assigned, churns across session
          // restarts) so the panel reconnects to the live stream, and the
          // resolved binary path alongside it.
          if (!existing.minimized && Object.keys(refreshedParams).length > 0) {
            lath.updateParams(existing.id, refreshedParams);
          } else if (existing.minimized && Object.keys(refreshedParams).length > 0) {
            const nextDoors = doorsRef.current.map((door) => door.id === existing.id
              ? { ...door, params: { ...door.params, ...refreshedParams } }
              : door);
            doorsRef.current = nextDoors;
            setDoors(nextDoors);
          }
          detail.respond({
            ok: true,
            result: {
              status: 'existing',
              surfaceId: existing.id,
              surfaceRef: surfaceRefForId(existing.id),
              session,
              minimized: existing.minimized,
            },
          });
          return;
        }

        const target = resolveVisibleSurface(stringParam(params.surface), detail.surfaceId);
        if (!target.ok) {
          detail.respond({ ok: false, error: target.message });
          return;
        }
        const result = createContentSurface({
          minimized: booleanParam(params.minimized),
          params: {
            surfaceType: 'browser',
            renderMode: 'ab-screencast',
            session,
            ...(key !== undefined ? { key } : {}),
            ...refreshedParams,
          },
          reference: target.value,
          title: key ?? session,
          // `dor ab` opens the screencast in the background; caller keeps focus.
          focusNeutral: true,
        });
        if (!result.ok) {
          detail.respond({ ok: false, error: result.message });
          return;
        }
        detail.respond({
          ok: true,
          result: {
            status: result.value.status,
            surfaceId: result.value.id,
            surfaceRef: result.value.ref,
            session,
            minimized: booleanParam(params.minimized),
          },
        });
        return;
      }

      detail.respond({ ok: false, error: `unsupported Dormouse control method '${detail.method}'` });
    };

    window.addEventListener('dormouse:control-request', handler);
    return () => window.removeEventListener('dormouse:control-request', handler);
  }, [buildDorSurfaces, createContentSurface, createSplitSurface, findAgentBrowserSurface, findSurfaceIdRunningCommand, killPaneImmediately, resolveVisibleSurface, surfaceRefForId, lath, nav]);

  const addSplitPanel = useCallback((
    id: string | null,
    direction: 'right' | 'below',
    splitDirection: 'horizontal' | 'vertical',
    source: 'keyboard' | 'mouse' = 'mouse',
  ) => {
    const newId = generatePaneId();
    const ref = id && nav.hasPane(id) ? id : null;
    // Carry the currently-selected shell into the split, same as [+].
    const defaults = getDefaultShellOpts();
    // Remote cwds (OSC 7 over ssh) name a path on the remote host, not one the local shell can chdir to.
    const sourceCwd = ref ? getTerminalPaneState(ref).cwd : null;
    const inheritedCwd = sourceCwd && !sourceCwd.isRemote ? sourceCwd.path : undefined;
    if (defaults?.shell || inheritedCwd) {
      setPendingShellOpts(newId, { shell: defaults?.shell, args: defaults?.args, cwd: inheritedCwd });
    }
    const panes = lath.listPanes();
    const refId = ref ?? (panes.length > 0 ? panes[panes.length - 1].id : null);
    const edge: Edge = direction === 'right' ? 'right' : 'bottom';
    // The enter hint is derived inside `addLeaf` from the edge it commits.
    lath.addLeaf(newId, terminalLeafMeta(), refId ? { refId, edge } : null);
    selectPane(newId);
    onEventRef.current?.({ type: 'split', direction: splitDirection, source });
  }, [selectPane, generatePaneId, lath, nav]);

  // --- Wall actions (for tab buttons) ---

  const wallActions: WallActions = useMemo(() => ({
    onKill: (id: string) => {
      exitTerminalMode();
      if (isUntouched(id)) {
        killPaneImmediately(id);
        return;
      }
      const char = randomKillChar();
      setConfirmKill({ id, char });
    },
    onAlertButton: (id: string, displayedStatus: SessionStatus) => {
      return dismissOrToggleAlert(id, displayedStatus);
    },
    onToggleTodo: (id: string) => {
      toggleSessionTodo(id);
    },
    onMinimize: (id: string) => {
      minimizePane(id);
    },
    onSplitH: (id: string | null, source: 'keyboard' | 'mouse' = 'mouse') => {
      addSplitPanel(id, 'right', 'horizontal', source);
    },
    onSplitV: (id: string | null, source: 'keyboard' | 'mouse' = 'mouse') => {
      addSplitPanel(id, 'below', 'vertical', source);
    },
    onZoom: (id: string) => {
      // Zoom is presentation state in the store (the tree is untouched). Toggle:
      // any leaf zoomed → unzoom; else zoom this leaf. The Wall's `zoomed` boolean
      // follows via the store subscription (below), which also un-zooms when a
      // kill/replace clears the zoomed leaf.
      const zoomedNow = lath.store.getSnapshot().zoomedId !== null;
      lath.setZoomed(zoomedNow ? null : id);
    },
    onClickPanel: (id: string) => {
      setConfirmKill(null);
      enterTerminalMode(id);
    },
    onFocusPane: (id: string) => {
      setConfirmKill(null);
      // Visible pane → jump straight in; minimized (a door) → reattach first.
      const visible = nav.hasPane(id);
      if (visible) {
        enterTerminalMode(id);
        return;
      }
      const door = doorsRef.current.find((item) => item.id === id);
      if (door) handleReattachRef.current(door, { enterPassthrough: true });
    },
    onStartRename: (id: string) => {
      setRenamingPaneId(id);
    },
    onFinishRename: (id: string, value: string) => {
      const trimmed = value.trim();
      if (!trimmed) {
        setRenamingPaneId(null);
        return { accepted: false, reason: 'empty' as const };
      }
      const result = setTerminalUserTitle(id, trimmed);
      if (result.accepted) {
        lath.setTitle(id, trimmed);
      }
      setRenamingPaneId(null);
      return result;
    },
    onCancelRename: () => {
      setRenamingPaneId(null);
    },
    onSwapRenderMode: (id, mode) => {
      const visible = nav.hasPane(id);
      if (!visible) return;
      const params = nav.paneParams(id);
      const currentType = surfaceTypeFromParams(params);

      // agent-browser → iframe: frame the active tab's URL, then the replace
      // closes the now-unneeded headless browser. Webview-only.
      if (currentType === 'agent-browser' && mode === 'iframe') {
        // Canonical params.url (mirrored from the chrome snapshot) first; fall
        // back to the live snapshot for a surface that hasn't reported a tab yet.
        const url = (typeof params?.url === 'string' && params.url) || getAgentBrowserScreenController(id)?.chrome().url;
        if (!url) return;
        replaceSurface(id, {
          params: { surfaceType: 'browser', renderMode: 'iframe', url },
          title: hostPathDisplay(url, true),
        });
        return;
      }

      // iframe → live agent-browser (ab-screencast or ab-popout): the host must
      // spawn a session for the URL (absent ⇒ inert, like other host-gated
      // affordances). ab-popout spawns headed directly so the new surface mounts
      // already popped-out (no headless launch + immediate relaunch flash).
      if (currentType === 'iframe' && (mode === 'ab-screencast' || mode === 'ab-popout')) {
        const chromeUrl = getAgentBrowserScreenController(id)?.chrome().url;
        const url = (typeof chromeUrl === 'string' && chromeUrl)
          || (typeof params?.url === 'string' ? params.url : undefined);
        const platform = getPlatform();
        if (!url || !platform.agentBrowserOpen) return;
        const headed = mode === 'ab-popout';
        platform.agentBrowserOpen(url, { headed }, lastAgentBrowserBinaryPathRef.current).then((res) => {
          if (!res.ok || !res.session) return;
          if (res.binaryPath) lastAgentBrowserBinaryPathRef.current = res.binaryPath;
          const nextParams = {
            surfaceType: 'browser',
            renderMode: mode,
            session: res.session,
            url,
            ...(res.wsPort !== undefined ? { wsPort: res.wsPort } : {}),
            ...(res.binaryPath !== undefined ? { binaryPath: res.binaryPath } : {}),
            syncEngaged: true,
          };
          const nextId = replaceSurface(id, {
            params: nextParams,
            title: hostPathDisplay(url, true),
          });
          if (!nextId) {
            closeAgentBrowserSession(nextParams);
            console.warn(`[dormouse] failed to replace iframe surface '${id}' with agent-browser surface`);
          }
        }).catch((err) => {
          console.warn('[dormouse] failed to swap iframe surface to agent-browser:', err);
        });
      }
    },
    onOpenBrowserPane: (id, url) => {
      // A new-tab request from the iframe shim → open the URL as a new iframe
      // browser pane, split next to the source (docs/specs/dor-browser.md →
      // "Iframe Shim").
      const reference = buildDorSurfaces().find((s) => s.id === id);
      if (!reference) return;
      createContentSurface({
        minimized: false,
        params: { surfaceType: 'browser', renderMode: 'iframe', url },
        reference,
        title: hostPathDisplay(url, true),
      });
    },
  }), [addSplitPanel, minimizePane, enterTerminalMode, exitTerminalMode, killPaneImmediately, replaceSurface, buildDorSurfaces, createContentSurface, lath, nav]);
  const wallActionsRef = useRef(wallActions);
  wallActionsRef.current = wallActions;

  // Engine-directed writes for the pane props contract (docs/specs/tiling-engine.md
  // → "Pane props contract"): route a pane/header's title / params writes to the
  // engine's per-leaf metadata. Memoized so the sink handed to panels via context
  // keeps a stable identity. The render-swap and wsPort-refresh param writes in
  // Wall.tsx above route through the same engine.
  const paneWrite = useMemo<PaneWriteActions>(() => ({
    setTitle: (id, title) => lath.setTitle(id, title),
    updateParams: (id, patch) => lath.updateParams(id, patch),
  }), [lath]);

  useWallKeyboard({
    nav,
    swapWithNeighbor,
    modeRef,
    selectedIdRef,
    selectedTypeRef,
    doorsRef,
    confirmKillRef,
    renamingRef,
    dialogKeyboardActiveRef,
    paneElements,
    wallActionsRef,
    handleReattachRef,
    selectPane,
    selectDoor,
    enterTerminalMode,
    exitTerminalMode,
    minimizePane,
    killPaneImmediately,
    acceptKill,
    rejectKill,
    setConfirmKill,
    setRenamingPaneId,
    setSelectedId,
    fireEvent,
  });

  // LathHost surfaces `focusin` inside a leaf as an op proposal (embed self-focus
  // adoption, acceptance row 8): passthrough → enter the leaf if selection differs;
  // command → move selection onto it.
  const onLeafFocused = useCallback((id: string) => {
    if (modeRef.current === 'passthrough') {
      if (selectedIdRef.current !== id) enterTerminalMode(id);
      return;
    }
    if (selectedTypeRef.current !== 'pane' || selectedIdRef.current !== id) selectPane(id);
  }, [enterTerminalMode, selectPane]);

  // Stable so LathHost's sash-drag effect never re-subscribes on a Wall re-render.
  const onCommitResize = useCallback((splitPath: number[], boundary: number, deltaPx: number) => {
    lath.store.resizeBoundary(splitPath, boundary, deltaPx);
  }, [lath]);

  // --- Pane / Door drag-and-drop (docs/specs/tiling-engine.md → "Hierarchical drag
  // and drop"). LathHost owns the gesture and hit-testing; the Wall owns the op
  // commit + selection policy. ---

  // A pane drag crossed its threshold: move selection onto the dragged pane (covers
  // "dragging while a door is selected moves selection onto the dragged pane").
  // `selectPane` is idempotent, so no pre-check is needed — a plain header press already
  // selected it, and re-selecting is a no-op. Passed to LathHost's `onDragStart` directly.

  // Drop of a pane onto a hit-tested target: commit the move (command mode unchanged),
  // then select it. A center-drop swap mirrors the Cmd-Arrow swap's `move` event so
  // tutorial/event consumers behave identically.
  const onProposeMove = useCallback((id: string, target: DropTarget) => {
    const r = lath.moveLeaf(id, target);
    if (!r.ok) return;
    if (target.kind === 'swap') fireEvent({ type: 'move', fromId: id, toId: target.leaf });
    selectPane(id);
  }, [lath, fireEvent, selectPane]);

  // Drop of a pane onto the baseboard zone: minimize it (captures the token + selects
  // the door, exactly like the header minimize button). No-op when the Baseboard is
  // hidden — there is nowhere for a below-wall release to minimize into.
  const onProposeMinimize = useCallback((id: string) => {
    if (!showBaseboard) return;
    minimizePane(id);
  }, [minimizePane, showBaseboard]);

  // A Door received a press in the baseboard — hand its item + press point to LathHost,
  // which starts an inactive external drag and applies the threshold.
  const onDoorDragStart = useCallback((item: DooredItem, press: { clientX: number; clientY: number }) => {
    setDoorDrag({ item, startX: press.clientX, startY: press.clientY });
  }, []);

  // Drop of a dragged-out Door: `null` (sub-threshold press, cancel, or no candidate)
  // clears the transient drag and leaves the Door where it is; a target reattaches the
  // surface at the hit-tested position. The token is NOT consulted — the user chose the
  // spot. The enter hint (from the target edge) is derived inside `insertLeaf`.
  const onExternalDrop = useCallback((target: DropTarget | null) => {
    const dd = doorDrag;
    setDoorDrag(null);
    if (!dd || !target) return;
    const item = dd.item;
    const r = lath.insertLeaf(item.id, leafMetaFromDoor(item), target);
    if (!r.ok) return; // insert failed (unexpected) → the Door stays put
    removeDoorAndSelect(item.id);
  }, [doorDrag, lath, removeDoorAndSelect]);

  // --- Render ---

  return (
    <ModeContext.Provider value={mode}>
      <SelectedIdContext.Provider value={selectedId}>
        <WallActionsContext.Provider value={wallActions}>
          <PaneWriteContext.Provider value={paneWrite}>
          <PaneElementsContext.Provider value={{ elements: paneElements, version: paneElementsVersion, bumpVersion: bumpPaneElementsVersion }}>
          <DoorElementsContext.Provider value={{ elements: doorElements, version: doorElementsVersion, bumpVersion: bumpDoorElementsVersion }}>
          <RenamingIdContext.Provider value={renamingPaneId}>
          <ZoomedContext.Provider value={zoomed}>
          <WindowFocusedContext.Provider value={windowFocused}>
          <DialogKeyboardContext.Provider value={setDialogKeyboardActive}>
          <div className="flex-1 min-h-0 flex flex-col bg-app-bg text-app-fg font-sans overflow-hidden">
            {/* The tiling area — 2px bottom inset keeps rounded panes distinct from the baseboard when present. */}
            <div className={clsx('flex-1 min-h-0 relative px-1.5 pt-1.5', showBaseboard ? 'pb-0.5' : 'pb-1.5')}>
              <div className={clsx('absolute inset-x-1.5 top-1.5', showBaseboard ? 'bottom-0.5' : 'bottom-1.5')}>
                <LathHost
                  lath={lath}
                  onCommitResize={onCommitResize}
                  onLeafFocused={onLeafFocused}
                  onDragStart={selectPane}
                  onProposeMove={onProposeMove}
                  onProposeMinimize={onProposeMinimize}
                  externalDrag={doorDrag ? { id: doorDrag.item.id, startX: doorDrag.startX, startY: doorDrag.startY } : null}
                  onExternalDrop={onExternalDrop}
                />
                <WorkspaceSelectionOverlay lathStore={lath.store} subscribeLathFrames={lath.subscribeFrames} selectedId={selectedId} selectedType={selectedType} mode={mode} />
              </div>
            </div>

            {/* Baseboard — always visible in the main shell; embedders may suppress it for constrained mobile prototypes. */}
            {showBaseboard ? (
              <Baseboard
                items={doors}
                onReattach={handleReattach}
                notice={baseboardNotice}
                onDoorDragStart={onDoorDragStart}
              />
            ) : null}

            {/* Kill confirmation overlay — centered over the pane being killed */}
            {confirmKill && (
              <KillConfirmOverlay
                confirmKill={confirmKill}
                paneElements={paneElements}
                onCancel={() => rejectKill()}
              />
            )}

            <ShellSpawnNotice
              notice={shellSpawnNotice}
              paneElements={paneElements}
              version={paneElementsVersion}
            />

            <ExternalLinkModalHost onKeyboardActiveChange={setDialogKeyboardActive} />
            <AgentBrowserScreenModalHost
              onKeyboardActiveChange={setDialogKeyboardActive}
              resolveLabel={surfaceRefForId}
            />
            {enableRemoteHost ? (
              <Suspense fallback={null}>
                <RemotePairingModalHost onKeyboardActiveChange={setDialogKeyboardActive} />
              </Suspense>
            ) : null}

          </div>
          </DialogKeyboardContext.Provider>
          </WindowFocusedContext.Provider>
          </ZoomedContext.Provider>
          </RenamingIdContext.Provider>
          </DoorElementsContext.Provider>
          </PaneElementsContext.Provider>
          </PaneWriteContext.Provider>
        </WallActionsContext.Provider>
      </SelectedIdContext.Provider>
    </ModeContext.Provider>
  );
}
