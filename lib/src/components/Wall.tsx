import { useRef, useState, useEffect, useCallback, useMemo, lazy, Suspense, type ReactNode } from 'react';
import { clsx } from 'clsx';
import {
  DockviewReact,
  themeAbyss,
  type DockviewTheme,
  type DockviewApi,
  type IDockviewPanel,
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
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
  swapTerminals,
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
import { orchestrateKill } from '../lib/kill-animation';
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
import { findPaneInDirection, findReattachNeighbor } from '../lib/spatial-nav';
import { cloneLayout, getLayoutStructureSignature } from '../lib/layout-snapshot';
import type { PersistedDoor } from '../lib/session-types';
import type { RestoreToken } from '../lib/lath/ops';
import { useDynamicPalette } from '../lib/themes/use-dynamic-palette';
import {
  TerminalPanelAdapter,
  BrowserPanelAdapter,
  TerminalPaneHeaderAdapter,
  SurfacePaneHeaderAdapter,
} from './wall/dockview-panel-adapters';
import { resolveRenderMode, isAgentBrowserParams, isBrowserParams } from './wall/browser-surface';
import { hostPathDisplay } from './wall/browser-url';
import { WorkspaceSelectionOverlay } from './wall/WorkspaceSelectionOverlay';
import { useDockviewReady } from './wall/use-dockview-ready';
import { withProgrammaticActivation } from '../lib/programmatic-activation';
import { pickSplitDirection, swapPanelTitles } from './wall/dockview-helpers';
import { isLathEnabled } from '../lib/feature-flags';
import { LathHost } from './wall/LathHost';
import {
  createLathWallEngine,
  terminalLeafMeta,
  browserLeafMeta,
  legacyTokenFromDoor,
  doorDirectionForEdge,
  dorDirectionForEdge,
  directionForArrow,
  type LathWallEngine,
  type LathPaneEntry,
} from './wall/lath-wall-engine';
import type { WallNav } from './wall/keyboard/types';
import { useWallKeyboard } from './wall/use-wall-keyboard';
import { useSessionPersistence } from './wall/use-session-persistence';
import { useDevServerPortCorrelation } from './wall/use-dev-server-ports';
import { useWindowFocused } from './wall/use-window-focused';
import {
  DialogKeyboardContext,
  DoorElementsContext,
  FreshlySpawnedContext,
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
import type { DoorAfterRestoreAction, DooredItem, WallEvent, WallMode, WallSelectionKind, SpawnDirection } from './wall/wall-types';

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

type DockviewSplitDirection = 'left' | 'right' | 'above' | 'below';

export type { DoorAfterRestoreAction, DooredItem, WallEvent, WallMode, WallSelectionKind, SpawnDirection } from './wall/wall-types';
export {
  DialogKeyboardContext,
  DoorElementsContext,
  FreshlySpawnedContext,
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

// --- Theme ---

const dormouseTheme: DockviewTheme = {
  ...themeAbyss,
  name: 'dormouse',
  gap: 6,
  dndOverlayMounting: 'absolute',
  dndPanelOverlay: 'group',
};

/** Compare two sorted ID arrays by value. */
function idsMatch(a: string[], b: string[]): boolean {
  if (import.meta.env.DEV) {
    const isSorted = (arr: string[]) => arr.every((v, i) => i === 0 || v >= arr[i - 1]);
    console.assert(isSorted(a) && isSorted(b), 'idsMatch: inputs must be sorted');
  }
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

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

/** Every browser surface uses dockview's `renderer:'always'`. The default
 *  (`onlyWhenVisible`) detaches/reattaches — i.e. *moves* — the panel DOM on
 *  activation; that reloads an <iframe>, and for the screencast canvas it moves
 *  the node mid-press, so a real click's mouseup lands on a different node and no
 *  `click` is synthesized (tab chips / page links silently did nothing). Keeping
 *  the panel always-mounted avoids both. Only ever called for 'browser' panels. */
function rendererForParams(_params: { renderMode?: unknown }): 'always' {
  return 'always';
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

function dockviewDirectionForDor(direction: DorResolvedSplitDirection): DockviewSplitDirection {
  switch (direction) {
    case 'left':
      return 'left';
    case 'right':
      return 'right';
    case 'up':
      return 'above';
    case 'down':
      return 'below';
  }
}

function dorDirectionForDockview(direction: 'right' | 'below'): DorResolvedSplitDirection {
  return direction === 'right' ? 'right' : 'down';
}

function spawnDirectionForDockview(direction: DockviewSplitDirection): SpawnDirection {
  return direction === 'above' || direction === 'below' ? 'top' : 'left';
}

// After a surface-adding op, settle focus and selection; returns whether it
// selected the new surface. A non-focus-neutral add selects the new pane
// outright. A focus-neutral add hands the active group back to `caller` (the
// active pane at entry) so the new pane renders without the active group
// wandering — this is purely a dockview-activation concern. Dormouse selection
// then moves onto the new surface only when the op replaced the pane the user
// was actually selected on (`selectionReplaced`); otherwise the user's
// selection would dangle on a removed panel. Selection policy is deliberately
// keyed on the user's selection, not on whether the captured `caller`
// (activePanel) survived: activePanel can diverge from selection (e.g. a `dor`
// op replacing an active-but-unselected pane while the user has a door
// selected).
function settleFocusAfterAdd(
  api: DockviewApi,
  focusNeutral: boolean,
  caller: IDockviewPanel | undefined,
  selectionReplaced: boolean,
  newId: string,
  selectPane: (id: string) => void,
): boolean {
  if (!focusNeutral) { selectPane(newId); return true; }
  if (caller && api.getPanel(caller.id)) caller.api.setActive();
  if (selectionReplaced) { selectPane(newId); return true; }
  return false;
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

// One body component for every browser surface; the legacy 'iframe' /
// 'agent-browser' names alias to it so dockview layouts persisted before the
// unification still resolve on restore.
const components = { terminal: TerminalPanelAdapter, browser: BrowserPanelAdapter, iframe: BrowserPanelAdapter, 'agent-browser': BrowserPanelAdapter };
const tabComponents = { terminal: TerminalPaneHeaderAdapter, surface: SurfacePaneHeaderAdapter };

// --- Main component ---

export function Wall({
  initialPaneIds,
  initialMode = 'command',
  restoredLayout,
  restoredLathLayout,
  initialDoors,
  onApiReady,
  onEvent,
  baseboardNotice,
  showBaseboard = true,
  enableRemoteHost = false,
}: {
  initialPaneIds?: string[];
  initialMode?: WallMode;
  restoredLayout?: unknown;
  /** The Lath persisted layout (dual-write half); preferred over `restoredLayout`
   *  when the `dormouse.flags.lath` flag is on. `restoredLayout` keeps carrying the
   *  bare dockview blob so flag-off paths are untouched. */
  restoredLathLayout?: unknown;
  initialDoors?: PersistedDoor[];
  onApiReady?: (api: DockviewApi) => void;
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
  const apiRef = useRef<DockviewApi | null>(null);
  const [dockviewApi, setDockviewApi] = useState<DockviewApi | null>(null);
  const dockviewContainerRef = useRef<HTMLDivElement | null>(null);

  // The Lath engine handle. Null when `dormouse.flags.lath` is off, so every
  // `if (lath)` branch below falls through to the untouched dockview path. Read
  // ONCE per mount (a reload is required to toggle — same contract as
  // abDebugLogs). When on, DockviewReact is never rendered and `apiRef.current`
  // stays null (docs/specs/tiling-engine.md → lath-rollout stage 2).
  const lath = useRef<LathWallEngine | null>(isLathEnabled() ? createLathWallEngine() : null).current;
  const restoredLathLayoutRef = useRef(restoredLathLayout);

  // Pane ID generation (instance-scoped, not module-level)
  const paneCounterRef = useRef(0);
  const generatePaneId = useCallback(() => {
    return `pane-${(++paneCounterRef.current).toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
  }, []);

  // Ids of panes that were just spawned, keyed by id with the direction the spawn
  // should reveal from. TerminalPanel consumes its id on first mount to play the
  // matching directional entrance animation.
  const freshlySpawnedRef = useRef(new Map<string, SpawnDirection>());

  const killInProgressRef = useRef(false);

  // "Programmatic activation" tag: depth > 0 while an add-side programmatic
  // dockview mutation is in flight, so the onDidActivePanelChange listener can
  // tell that activation churn apart from a genuine user click and leave
  // selection/mode alone. dockview fires the same event for both. The tag is set
  // via withProgrammaticActivation around runSurfaceAdd's add (focus-neutral
  // surface creation, layout.md corner case #12); see programmatic-activation.ts
  // for the full design rationale (why a depth counter, the synchronicity
  // assumption, and why removal-side echoes are deliberately not tagged).
  const programmaticActivationRef = useRef(0);

  // Ref to the WorkspaceSelectionOverlay's root element. orchestrateKill uses it to
  // animate the focus ring in sync with the killed pane's shrink (last-pane case).
  const overlayElRef = useRef<HTMLDivElement | null>(null);

  const dialogKeyboardActiveRef = useRef(false);
  const setDialogKeyboardActive = useCallback((active: boolean) => {
    dialogKeyboardActiveRef.current = active;
  }, []);

  // Consumed once in handleReady to restore existing sessions
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

  // We own these — dockview is just for spatial layout and DnD
  const [mode, setMode] = useState<WallMode>(initialMode);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<WallSelectionKind>('pane');

  const windowFocused = useWindowFocused();
  useDynamicPalette();

  // UI state
  const [confirmKill, setConfirmKill] = useState<ConfirmKill | null>(null);
  const [renamingPaneId, setRenamingPaneId] = useState<string | null>(null);
  const [doors, setDoors] = useState<DooredItem[]>(() => (initialDoors ?? []) as DooredItem[]);
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

  // Engine-neutral visible-pane projection (docs/specs/tiling-engine.md → "Pane
  // props contract"): the shared shape `buildDorSurfaces`, persistence, and the
  // dev-server correlation read instead of touching `api.panels` directly. Under
  // Lath it is the tree's pre-order leaves + meta; under dockview the live panels.
  const listVisiblePanes = useCallback((): LathPaneEntry[] => {
    if (lath) return lath.listPanes();
    return apiRef.current?.panels.map((p) => ({
      id: p.id,
      title: p.title ?? undefined,
      params: p.params as Record<string, unknown> | undefined,
    })) ?? [];
  }, [lath]);

  // Engine-neutral navigation/query seam for the keyboard handlers (they can no
  // longer read `apiRef.current`, which is null under Lath).
  const nav = useMemo<WallNav>(() => ({
    ready: () => (lath ? true : !!apiRef.current),
    findInDirection: (id, dir) => {
      if (lath) return lath.neighborOf(id, directionForArrow(dir));
      const api = apiRef.current;
      return api ? findPaneInDirection(id, dir, api, paneElements) : null;
    },
    paneParams: (id) =>
      lath ? lath.getMeta(id)?.params : (apiRef.current?.getPanel(id)?.params as Record<string, unknown> | undefined),
    hasPane: (id) => (lath ? lath.has(id) : !!apiRef.current?.getPanel(id)),
    panes: () => (lath ? lath.listPanes().map((p) => p.id) : apiRef.current?.panels.map((p) => p.id) ?? []),
  }), [lath, paneElements]);
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

  // Confirm runs orchestrateKill concurrently with the letter flash so the
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

  /** Select a panel: update our state + tell dockview so tabs highlight correctly */
  const selectPane = useCallback((id: string) => {
    selectedIdRef.current = id;
    selectedTypeRef.current = 'pane';
    setSelectedId(id);
    setSelectedType('pane');
    // Under Lath `apiRef.current` is null (DockviewReact never mounts), so this
    // block is naturally skipped — Wall state is the sole selection authority.
    const panel = apiRef.current?.getPanel(id);
    // The echo of our own setActive is not user intent; the refs written above
    // already neutralized it (selectedIdRef.current === panel.id, so the listener
    // no-ops), and the tag makes that ordering non-load-bearing.
    if (panel) withProgrammaticActivation(programmaticActivationRef, () => panel.api.setActive());
  }, []);

  // Swap two panes' surfaces (Cmd-Arrow). dockview: swap registry entries + panel
  // titles (dockview tracks titles on the panel). Lath: swap leaf identities — meta
  // and registry entries follow ids, so there is no companion title swap.
  const swapWithNeighbor = useCallback((fromId: string, toId: string) => {
    if (lath) { lath.swapLeaves(fromId, toId); return; }
    swapTerminals(fromId, toId);
    const api = apiRef.current;
    if (api) swapPanelTitles(api, fromId, toId);
  }, [lath]);

  // The selection tail of a surface-adding op on the Lath path (the dockview path
  // uses settleFocusAfterAdd, which additionally hands the active group back). A
  // non-focus-neutral add selects the new pane; a focus-neutral add moves selection
  // onto it only when it replaced the pane the user was selected on.
  const settleAddSelection = useCallback((focusNeutral: boolean, selectionReplaced: boolean, newId: string): boolean => {
    if (!focusNeutral || selectionReplaced) { selectPane(newId); return true; }
    return false;
  }, [selectPane]);

  // Restore DOM focus to the selected pane after a dockview mutation (addPanel /
  // removePanel) re-parents its grid subtree and blurs it. Deferred a frame past
  // dockview's own post-mutation focus handling. The first gate (selected pane in
  // passthrough) is TerminalPane's `isFocused` condition, so this only ever heals
  // the pane the effect itself would keep focused. `document.hasFocus()` keeps a
  // background `dor` command from yanking cross-frame focus out of the host editor
  // (VS Code: a webview blur leaves mode/selectedId untouched). The editable-control
  // check keeps it from yanking in-page focus the user placed deliberately (e.g. the
  // inline-rename input) — re-parent blur drops focus to `<body>`, so a focused
  // control means the user chose it; the `xterm-helper-textarea` exemption is the
  // terminal's own textarea, where re-focusing is idempotent. See docs/specs/layout.md
  // corner case #12.
  const reassertPaneFocus = useCallback((id: string) => {
    requestAnimationFrame(() => {
      if (modeRef.current !== 'passthrough' || selectedTypeRef.current !== 'pane' || selectedIdRef.current !== id) return;
      if (!document.hasFocus()) return;
      const ae = document.activeElement;
      const inEditableControl = ae instanceof HTMLElement
        && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)
        && !ae.classList.contains('xterm-helper-textarea');
      if (inEditableControl) return;
      focusSession(id, true);
    });
  }, []);

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
    const api = apiRef.current;
    if (!api && !lath) return;
    const isVisiblePane = lath ? lath.has(id) : !!api!.getPanel(id);
    if (!isVisiblePane) {
      // A doored surface has no visible pane but still owns a live session
      // (its PTY keeps running). `dor ensure --minimize`'s integration-timeout
      // teardown lands here: the throwaway was created straight into a door. This
      // branch is engine-free except the survivor fallback.
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
        const survivorId = lath ? (lath.listPanes()[0]?.id ?? null) : (api!.activePanel?.id ?? null);
        if (survivorId) selectPane(survivorId);
        else setSelectedId(null);
      }
      clearLocalSurfaceActivity(id);
      fireEvent({ type: 'kill', id });
      return;
    }
    const params = lath ? lath.getMeta(id)?.params : api!.getPanel(id)!.params;
    closeAgentBrowserSession(params);
    // Release the surface's client-side controller (connection, loops, timers,
    // screen registration). A safe no-op for iframe/terminal surfaces.
    disposeAgentBrowserSurfaceController(id);
    if (lath) {
      // Instant kill (animation is stage 3). Preserve the policy tail exactly: the
      // restore token is discarded (kills don't restore); removing the last leaf
      // empties the tree and the auto-spawn effect fills it. Only a kill of the
      // selected pane moves selection — `dor kill` of a background surface leaves
      // it (and under Lath focus is never lost, so nothing to heal).
      const wasSelectedPane = selectedTypeRef.current === 'pane' && selectedIdRef.current === id;
      lath.removeLeaf(id);
      disposeSession(id);
      if (wasSelectedPane) {
        const survivorId = lath.listPanes()[0]?.id ?? null; // matches orchestrateKill's api.panels[0] tail
        if (survivorId) selectPane(survivorId);
        else setSelectedId(null);
      }
    } else {
      // Only a kill of the selected pane should move selection; `dor kill` of a
      // background surface (and ensure's throwaway teardown) leaves it. The check is
      // LIVE — orchestrateKill re-reads it at removal time (up to ~1s after the fade
      // starts), so a mid-fade selection move is honored. The `=== 'pane'` term keeps
      // a doored id from ever reading as selected for the kill tail. Mouse kills always
      // arrive selected — clicking a pane header activates it (dockview's pointerdown)
      // before the kill button's click handler runs.
      const isSelectedPane = (kid: string) =>
        selectedTypeRef.current === 'pane' && selectedIdRef.current === kid;
      // removePanel can collapse a branch, re-parenting + blurring the survivor. If
      // selection is unchanged (background kill), TerminalPane's effect won't heal it,
      // so re-assert here; for a selected-pane kill the tail's selectPane changes
      // selection, so the rAF gate no-ops (harmless).
      const focusId = selectedTypeRef.current === 'pane' ? selectedIdRef.current : null;
      orchestrateKill(api!, id, isSelectedPane, selectPane, setSelectedId, killInProgressRef, overlayElRef, programmaticActivationRef, focusId ? () => reassertPaneFocus(focusId) : undefined);
    }
    clearLocalSurfaceActivity(id);
    fireEvent({ type: 'kill', id });
  }, [fireEvent, selectPane, reassertPaneFocus, lath]);

  const acceptKill = useCallback(() => {
    const ck = confirmKillRef.current;
    if (!ck || ck.exit) return;
    const staged = { ...ck, exit: 'confirm' as const };
    // Written to the ref synchronously, not just via setState: the ref otherwise
    // updates on the NEXT render, so a second confirm keydown arriving before
    // React flushes would pass this guard and kill the same pane twice (two
    // orchestrateKill animations racing one animationend — the second removePanel
    // then throws dockview's 'invalid operation' on the already-removed panel).
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
    // Defer focus so it happens after mousedown/click event finishes,
    // preventing dockview from stealing focus back from xterm
    requestAnimationFrame(() => focusSession(id, true));
    const panel = apiRef.current?.getPanel(id);
    // Same as selectPane: the echo of our own setActive is not user intent; the
    // refs+mode written above already neutralized it, and the tag makes that
    // ordering non-load-bearing.
    if (panel) withProgrammaticActivation(programmaticActivationRef, () => panel.api.setActive());
  }, []);
  const enterTerminalModeRef = useRef(enterTerminalMode);
  enterTerminalModeRef.current = enterTerminalMode;

  /** Minimize a pane: capture the restore context, remove the pane, add a Door. */
  const minimizePane = useCallback((id: string, opts?: { select?: boolean }) => {
    let door: DooredItem | null = null;

    if (lath) {
      const meta = lath.getMeta(id);
      if (!meta) return;
      const surfaceType = surfaceTypeFromParams(meta.params);
      // Capture the legacy `remainingPaneIds` (compat field) before the removal;
      // the real payload is the core token below.
      const remainingPaneIds = lath.listPanes().filter(p => p.id !== id).map(p => p.id).sort();
      const { token } = lath.removeLeaf(id); // may auto-spawn if this was the last leaf
      if (!token) return;
      clearSessionAttention(id);
      door = {
        id,
        title: persistedPanelTitle(meta.title),
        component: componentForSurfaceType(surfaceType),
        tabComponent: tabComponentForSurfaceType(surfaceType),
        params: meta.params,
        // The core token is the real restore payload; the legacy fields are filled
        // for compatibility (docs/specs/tiling-engine.md → "Restore tokens").
        token,
        neighborId: token.siblingId,
        direction: doorDirectionForEdge(token.edge),
        remainingPaneIds,
        layoutAtMinimize: null,
        layoutAtMinimizeSignature: '',
      };
    } else {
      const api = apiRef.current;
      if (!api) return;
      const panel = api.getPanel(id);
      if (!panel) return;
      const title = persistedPanelTitle(panel.title);
      const surfaceType = surfaceTypeFromParams(panel.params);
      const layoutAtMinimize = cloneLayout(api.toJSON());

      // Capture the nearest adjacent pane and our actual relative position
      // so immediate restore can reconstruct the original split precisely.
      const { neighborId, direction } = findReattachNeighbor(id, api, paneElements);

      const remainingPaneIds = api.panels
        .filter(p => p.id !== id)
        .map(p => p.id)
        .sort();

      // The removal's survivor-activation echo is not user intent — selection is
      // settled explicitly right after (selectDoor on the user path; the
      // focus-neutral `--minimize` path leaves selection per its `select: false`).
      withProgrammaticActivation(programmaticActivationRef, () => {
        api.removePanel(panel);
      });
      clearSessionAttention(id);
      const layoutAtMinimizeSignature = getLayoutStructureSignature(api.toJSON());
      door = {
        id,
        title,
        component: componentForSurfaceType(surfaceType),
        tabComponent: tabComponentForSurfaceType(surfaceType),
        params: panel.params,
        neighborId,
        direction,
        remainingPaneIds,
        layoutAtMinimize,
        layoutAtMinimizeSignature,
      };
    }

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

  // The dockview onReady callback. Under Lath this is never wired to a
  // DockviewReact (which is not rendered), so it never fires; the hook is still
  // called unconditionally to satisfy the rules of hooks.
  const handleReady = useDockviewReady({
    apiRef,
    initialPaneIdsRef,
    restoredLayoutRef,
    initialDoorsRef,
    doorsRef,
    freshlySpawnedRef,
    killInProgressRef,
    programmaticActivationRef,
    selectedIdRef,
    selectedTypeRef,
    modeRef,
    enterTerminalModeRef,
    generatePaneId,
    selectPane,
    setDockviewApi,
    setDoors,
    setSelectedId,
    onApiReady,
  });

  // --- Lath seed + auto-spawn (replaces useDockviewReady's ready/auto-spawn) ---
  const lathSeededRef = useRef(false);
  useEffect(() => {
    if (!lath || lathSeededRef.current) return;
    lathSeededRef.current = true;

    // Restore doors exactly as handleReady does.
    const restoredDoors = initialDoorsRef.current;
    doorsRef.current = restoredDoors;
    setDoors(restoredDoors);

    // Hydrate: prefer the Lath blob, migrate the dockview blob, else fresh panes.
    const { paneIds, fresh } = lath.seed(
      restoredLathLayoutRef.current,
      restoredLayoutRef.current,
      initialPaneIdsRef.current,
      generatePaneId,
    );
    // Prime default-shell opts for the fresh path's generated ids (mirrors
    // addTerminalPanel's primeDefaultShell; a no-op for already-restored ids).
    if (fresh) {
      const defaults = getDefaultShellOpts();
      if (defaults?.shell) {
        for (const id of paneIds) setPendingShellOpts(id, { shell: defaults.shell, args: defaults.args });
      }
    }
    setSelectedId(paneIds[0] ?? null);
    // onApiReady is dockview-only and never fires under Lath (the website tutorial
    // / tut-detector require flag-off — acceptable for a dev flag through stage 4).
  }, [lath, generatePaneId]);

  // Auto-spawn: whenever a commit empties the tree (last pane killed/minimized),
  // spawn one to keep a pane visible — the Wall's "always one pane" rule, moved off
  // dockview's onDidRemovePanel. Instant (no kill animation until stage 3).
  useEffect(() => {
    if (!lath) return;
    return lath.store.subscribe(() => {
      if (lath.store.getSnapshot().tree.root !== null) return;
      const id = generatePaneId();
      const defaults = getDefaultShellOpts();
      if (defaults?.shell) setPendingShellOpts(id, { shell: defaults.shell, args: defaults.args });
      freshlySpawnedRef.current.set(id, 'top-left');
      lath.addLeaf(id, terminalLeafMeta(), null); // becomes the root
      // Adopt selection only when it points at nothing real: null, or dangling (a
      // just-killed pane). A live door (last pane minimized) keeps selection.
      const sel = selectedIdRef.current;
      const selDangling = sel !== null && selectedTypeRef.current === 'pane' && !lath.has(sel);
      if (sel === null || selDangling) selectPane(id);
    });
  }, [lath, generatePaneId, selectPane]);

  // --- Session persistence ---
  useSessionPersistence({
    dockviewApi,
    apiRef,
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
    const api = apiRef.current;
    if (!api && !lath) return;
    const enterPassthrough = options?.enterPassthrough ?? true;
    const afterRestore = options?.afterRestore;

    if (lath) {
      // Restore through the core token (the real payload): exact tier when the
      // captured context survives, else neighbor, else fallback beside a live ref.
      // A pre-Lath door has no token — synthesize a neighbor-tier one from its
      // {neighborId, direction} so it restores beside its old neighbor.
      const meta = {
        component: item.component ?? 'terminal',
        tabComponent: item.tabComponent ?? 'terminal',
        title: item.title,
        params: item.params,
      };
      const token = (item.token as RestoreToken | undefined) ?? legacyTokenFromDoor(item);
      const sel = selectedIdRef.current;
      const fallbackRef = sel && selectedTypeRef.current === 'pane' && lath.has(sel)
        ? sel
        : lath.listPanes()[0]?.id;
      const r = lath.restoreLeaf(meta, token, { fallbackRef });
      // `!ok` means no fallback was possible (empty tree) — make the leaf the root.
      if (!r.ok) lath.addLeaf(item.id, meta, null);
    } else {
      const dvApi = api!;
      const currentLayoutSignature = getLayoutStructureSignature(dvApi.toJSON());
      // Exact reattach is only safe when the layout structure matches AND the
      // current panes are the same ones that existed when we minimized. If new
      // panes were auto-spawned (e.g. last pane minimized → auto-create), the
      // layoutAtMinimize would destroy them.
      const currentPaneIds = dvApi.panels.map(p => p.id).sort();
      const reattachPaneIds = item.layoutAtMinimize
        ? Object.keys(item.layoutAtMinimize.panels).filter(id => id !== item.id).sort()
        : [];
      const canReattachExactLayout =
        !!item.layoutAtMinimize &&
        currentLayoutSignature === item.layoutAtMinimizeSignature &&
        idsMatch(currentPaneIds, reattachPaneIds);

      // Reattach mutations (the exact-layout fromJSON restore or the addPanel
      // fallbacks) activate a pane as a side effect; selection is established
      // explicitly right after (selectPane / enterTerminalMode below). Tag them so
      // the listener treats the echo as programmatic — with the door guard gone,
      // this tag is the only thing keeping the echo from reading as user intent.
      withProgrammaticActivation(programmaticActivationRef, () => {
        if (canReattachExactLayout) {
          const currentTitles = new Map(
            dvApi.panels.map(panel => [panel.id, panel.title ?? panel.id] as const),
          );

          // reuseExistingPanels: keep existing panel component instances mounted
          // rather than destroying and recreating them during deserialization.
          dvApi.fromJSON(cloneLayout(item.layoutAtMinimize!), { reuseExistingPanels: true });

          for (const [panelId, title] of currentTitles) {
            if (panelId === item.id) continue;
            dvApi.getPanel(panelId)?.api.setTitle(title);
          }
        } else {
          const currentIds = dvApi.panels.map(p => p.id).sort();
          const layoutUnchanged =
            item.neighborId &&
            dvApi.getPanel(item.neighborId) &&
            idsMatch(currentIds, item.remainingPaneIds);

          if (layoutUnchanged) {
            // Restore to original position next to the same neighbor
            dvApi.addPanel({
              id: item.id,
              component: item.component ?? 'terminal',
              tabComponent: item.tabComponent ?? 'terminal',
              title: item.title,
              params: item.params,
              position: { referencePanel: item.neighborId!, direction: item.direction },
            });
          } else {
            // Layout changed — split an existing panel based on its aspect ratio
            const sid = selectedIdRef.current;
            const refPanel = (sid && dvApi.getPanel(sid)) ?? dvApi.panels[0] ?? null;
            dvApi.addPanel({
              id: item.id,
              component: item.component ?? 'terminal',
              tabComponent: item.tabComponent ?? 'terminal',
              title: item.title,
              params: item.params,
              position: refPanel ? { referencePanel: refPanel.id, direction: pickSplitDirection(refPanel) } : undefined,
            });
          }
        }
      });
    }

    const nextDoors = doorsRef.current.filter(p => p.id !== item.id);
    doorsRef.current = nextDoors;
    setDoors(nextDoors);
    selectPane(item.id);
    if (enterPassthrough) {
      enterTerminalMode(item.id);
    } else {
      modeRef.current = 'command';
      setMode('command');
      requestAnimationFrame(() => {
        // Guard against removal between scheduling and execution.
        if (lath ? !lath.has(item.id) : !apiRef.current?.getPanel(item.id)) return;
        focusSession(item.id, false);
        if (afterRestore === 'kill-immediately') {
          killPaneImmediately(item.id);
        } else if (afterRestore === 'confirm-kill') {
          setConfirmKill({ id: item.id, char: randomKillChar() });
        } else if (typeof afterRestore === 'object' && afterRestore.type === 'replace-terminal') {
          if (lath) {
            // Atomic identity swap in place — no transient add/remove.
            lath.replaceLeaf(item.id, afterRestore.newId, terminalLeafMeta());
            disposeSession(item.id);
            selectPane(afterRestore.newId);
            if (afterRestore.announce) {
              showShellSpawnNotice(afterRestore.newId, `Switched to ${afterRestore.shellName}`);
            }
            return;
          }
          const panel = apiRef.current?.getPanel(item.id);
          if (!panel) return;
          // Add the replacement then drop the reattached pane. Both mutations
          // activate a pane, and the explicit selectPane(newId) right after is the
          // real selection intent, so tag the add+remove pair — the removePanel's
          // activate-the-survivor echo is redundant when selectPane immediately
          // follows. (disposeSession is synchronous and unrelated to activation.)
          withProgrammaticActivation(programmaticActivationRef, () => {
            apiRef.current?.addPanel({
              id: afterRestore.newId,
              component: 'terminal',
              tabComponent: 'terminal',
              title: UNNAMED_PANEL_TITLE,
              position: { referencePanel: panel, direction: 'within' },
            });
            disposeSession(item.id);
            apiRef.current?.removePanel(panel);
          });
          selectPane(afterRestore.newId);
          if (afterRestore.announce) {
            showShellSpawnNotice(afterRestore.newId, `Switched to ${afterRestore.shellName}`);
          }
        }
      });
    }
  }, [selectPane, enterTerminalMode, killPaneImmediately, showShellSpawnNotice, lath]);
  const handleReattachRef = useRef(handleReattach);
  handleReattachRef.current = handleReattach;

  // Engine-neutral: the visible panes + the active/selected surface, with no
  // dockview api. Under Lath the "active" surface is simply the selected pane
  // (there is no dockview activePanel).
  const buildDorSurfaces = useCallback((): DorSurface[] => {
    const panels = listVisiblePanes();
    const activeId = lath
      ? (selectedTypeRef.current === 'pane' ? selectedIdRef.current : null)
      : (apiRef.current?.activePanel?.id ?? (selectedTypeRef.current === 'pane' ? selectedIdRef.current : null));
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
  }, [listVisiblePanes, lath]);

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

  // Run a surface-adding `add`, focus-neutrally when asked — the shared machinery
  // behind focus-neutral `dor ensure` / `dor iframe` / `dor ab` (vs. plain `dor
  // split`). When not focus-neutral, `add` runs directly with no caller. When it
  // is: dockview renders a pane only once it becomes its group's active panel, so
  // `add` must activate the new pane and the onDidActivePanelChange listener would
  // follow it — we run `add` inside withProgrammaticActivation so the listener
  // ignores that activation churn for the duration, and pass `add` the caller
  // panel (the active pane at entry) purely as the activation hand-back target (via
  // settleFocusAfterAdd, which reactivates it); selection policy is decided
  // separately there from the user's selection (selectionReplaced), not the caller.
  // Adding the pane re-parents the selected pane's grid subtree, blurring its focus;
  // since selection never moved, TerminalPane's effect won't reclaim it, so we
  // re-assert focus through the shared reassertPaneFocus helper (keyed on the user's
  // selection, not the caller — matching the selection-based policy; its rAF gate
  // re-checks selection, so a legitimate selection move like selectionReplaced makes
  // it a no-op). See docs/specs/layout.md corner case #12.
  const runSurfaceAdd = useCallback((
    focusNeutral: boolean | undefined,
    add: (caller: IDockviewPanel | undefined) => void,
  ) => {
    // Under Lath an add never re-parents or steals activation, so every add is
    // inherently focus-neutral: no caller hand-back, no activation tag, no focus
    // re-assert. The `add` closure applies selection policy itself (settleAddSelection).
    if (lath) { add(undefined); return; }
    if (!focusNeutral) { add(undefined); return; }
    const caller = apiRef.current?.activePanel ?? undefined;
    const focusId = selectedTypeRef.current === 'pane' ? selectedIdRef.current : null;
    withProgrammaticActivation(programmaticActivationRef, () => add(caller));
    if (focusId) reassertPaneFocus(focusId);
  }, [reassertPaneFocus, lath]);

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
    // `dor ensure` must never move focus: activate the new pane only transiently
    // to force a render, then hand activation back to the caller, leaving the
    // caller's selection, mode, and DOM focus intact.
    focusNeutral?: boolean;
  }): ParseResult<{
    id: string;
    ref: string;
  }> => {
    const api = apiRef.current;
    if (!api && !lath) return { ok: false, message: 'Dormouse layout is not ready yet' };
    const referenceVisible = lath ? lath.has(referenceId) : !!api!.getPanel(referenceId);
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

    const dockDirection = dockviewDirectionForDor(direction);
    freshlySpawnedRef.current.set(newId, spawnDirectionForDockview(dockDirection));

    // dockview renders a pane only once active in its group, so we can't add it
    // `inactive`; runSurfaceAdd adds it active and, when focus-neutral, hands the
    // active group back to the caller (settleFocusAfterAdd) so it renders without
    // stealing focus. `dor split` (not focus-neutral) just selects the new pane.
    // Under Lath adds never steal focus, so the split is inherently background.
    runSurfaceAdd(focusNeutral, (caller) => {
      let selectedNew: boolean;
      if (lath) {
        lath.addLeaf(newId, terminalLeafMeta(), { refId: referenceId, edge: lath.edgeForDorDirection(direction) });
        selectedNew = settleAddSelection(!!focusNeutral, false, newId);
      } else {
        api!.addPanel({
          id: newId,
          component: 'terminal',
          tabComponent: 'terminal',
          title: UNNAMED_PANEL_TITLE,
          position: { referencePanel: referenceId, direction: dockDirection },
        });
        selectedNew = settleFocusAfterAdd(api!, !!focusNeutral, caller, false, newId, selectPane);
      }
      onEventRef.current?.({
        type: 'split',
        direction: direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical',
        source: 'dor',
      });
      if (minimized) {
        getOrCreateTerminal(newId);
        minimizePane(newId, { select: selectedNew });
      }
    });
    return { ok: true, value: { id: newId, ref: surfaceRefForId(newId) } };
  }, [runSurfaceAdd, generatePaneId, minimizePane, selectPane, surfaceRefForId, lath, settleAddSelection]);

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
    const api = apiRef.current;
    if (!api && !lath) return { ok: false, message: 'Dormouse layout is not ready yet' };
    const referenceVisible = lath ? lath.has(reference.id) : !!api!.getPanel(reference.id);
    if (!referenceVisible) return { ok: false, message: `surface '${reference.ref}' is not visible` };

    // One component for every browser surface; the renderer is derived per mode.
    const component = 'browser';
    const renderer = rendererForParams(params);
    const newId = generatePaneId();
    const browserMeta = browserLeafMeta(title, params);
    const replaceUntouchedTerminal = reference.type === 'terminal' && isUntouched(reference.id);

    // Shared dockview panel spec for both paths; they differ only in position.direction.
    const panelSpec = {
      id: newId,
      component,
      tabComponent: 'surface',
      title,
      params,
      // Keep iframes mounted across (de)activation — dockview's default
      // onlyWhenVisible renderer detaches/reattaches panel DOM, and moving an
      // <iframe> in the DOM reloads it (docs/specs/dor-browser.md).
      renderer,
    } as const;

    if (replaceUntouchedTerminal) {
      // Whether the user's current selection sits on the pane being replaced.
      const selectionReplaced = selectedTypeRef.current === 'pane' && selectedIdRef.current === reference.id;
      runSurfaceAdd(focusNeutral, (caller) => {
        let selectedNew: boolean;
        if (lath) {
          // Atomic identity swap in place; then dispose the old terminal session.
          lath.replaceLeaf(reference.id, newId, browserMeta);
          disposeSession(reference.id);
          selectedNew = settleAddSelection(!!focusNeutral, selectionReplaced, newId);
        } else {
          const referencePanel = api!.getPanel(reference.id)!;
          api!.addPanel({ ...panelSpec, position: { referencePanel: reference.id, direction: 'within' } });
          disposeSession(reference.id);
          api!.removePanel(referencePanel);
          // Replacing the pane the user is selected on forces selection onto the
          // replacement (settleFocusAfterAdd selects it); replacing any other pane
          // leaves the user's selection — including a door selection — untouched.
          selectedNew = settleFocusAfterAdd(api!, !!focusNeutral, caller, selectionReplaced, newId, selectPane);
        }
        // When we did move selection onto the new pane, a minimize must carry it
        // onto the resulting door rather than leave selectedType='pane' pointing
        // at a door id (the overlay would keep a stale rect).
        if (minimized) minimizePane(newId, { select: selectedNew });
      });
      return { ok: true, value: { id: newId, ref: surfaceRefForId(newId), status: 'replaced' } };
    }

    // Split beside the reference by its aspect ratio (dockview: pickSplitDirection;
    // Lath: autoEdge). The spawn/animation + split-event direction derive from it.
    const lathEdge = lath ? lath.autoEdgeFor(reference.id) : null;
    const dvDirection = lath ? null : pickSplitDirection(api!.getPanel(reference.id)!);
    freshlySpawnedRef.current.set(newId, (lath ? lathEdge === 'bottom' : dvDirection === 'below') ? 'top' : 'left');
    const horizontal = lath ? lathEdge === 'right' : dvDirection === 'right';
    runSurfaceAdd(focusNeutral, (caller) => {
      let selectedNew: boolean;
      if (lath) {
        lath.addLeaf(newId, browserMeta, { refId: reference.id, edge: lathEdge! });
        selectedNew = settleAddSelection(!!focusNeutral, false, newId);
      } else {
        api!.addPanel({ ...panelSpec, position: { referencePanel: reference.id, direction: dvDirection! } });
        selectedNew = settleFocusAfterAdd(api!, !!focusNeutral, caller, false, newId, selectPane);
      }
      onEventRef.current?.({
        type: 'split',
        direction: horizontal ? 'horizontal' : 'vertical',
        source: 'dor',
      });
      if (minimized) minimizePane(newId, { select: selectedNew });
    });
    return { ok: true, value: { id: newId, ref: surfaceRefForId(newId), status: 'created' } };
  }, [runSurfaceAdd, generatePaneId, minimizePane, selectPane, surfaceRefForId, lath, settleAddSelection]);

  // The last binary path a `dor ab` surface resolved on a terminal's PATH.
  // Re-used to spawn an agent-browser when swapping an iframe embed up to a
  // screencast, since the webview/host PATH may not find the binary itself.
  const lastAgentBrowserBinaryPathRef = useRef<string | undefined>(undefined);

  /**
   * Replace a content surface's renderer in place, preserving its dock slot
   * (docs/specs/dor-browser.md → "Display Modal And Render Swaps"). Adds the
   * new panel `within` the old one, closes the old surface's session if any,
   * then removes the old panel and selects the new. The generalized form of
   * createContentSurface's replace-untouched-terminal branch.
   */
  const replaceSurface = useCallback((oldId: string, next: {
    params: Record<string, unknown>;
    title: string;
  }): string | null => {
    const api = apiRef.current;
    const oldParams = lath ? lath.getMeta(oldId)?.params : api?.getPanel(oldId)?.params;
    const oldVisible = lath ? lath.has(oldId) : !!api?.getPanel(oldId);
    if (!oldVisible) return null;
    closeAgentBrowserSession(oldParams);
    // The old renderer's controller is going away with this swap; release its
    // client-side resources (no-op for a non-agent-browser surface).
    disposeAgentBrowserSurfaceController(oldId);
    const newId = generatePaneId();
    if (lath) {
      lath.replaceLeaf(oldId, newId, browserLeafMeta(next.title, next.params));
    } else {
      const panel = api!.getPanel(oldId)!;
      api!.addPanel({
        id: newId,
        component: 'browser',
        tabComponent: 'surface',
        title: next.title,
        params: next.params,
        renderer: rendererForParams(next.params),
        position: { referencePanel: panel, direction: 'within' },
      });
      api!.removePanel(panel);
    }
    clearLocalSurfaceActivity(oldId);
    selectPane(newId);
    return newId;
  }, [generatePaneId, selectPane, lath]);

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
      const api = apiRef.current;
      if (!api && !lath) return;
      const detail = ((e as CustomEvent<ShellSpawnRequest>).detail ?? {}) as ShellSpawnRequest;
      const newId = generatePaneId();

      // Store shell options so getOrCreateTerminal picks them up on mount
      if (detail?.shell) {
        setPendingShellOpts(newId, { shell: detail.shell, args: detail.args });
      }

      const selectedPaneId = selectedTypeRef.current === 'pane' ? selectedIdRef.current : null;
      const selectedPaneVisible = !!selectedPaneId && (lath ? lath.has(selectedPaneId) : !!api!.getPanel(selectedPaneId));
      const selectedDoor = selectedTypeRef.current === 'door'
        ? doorsRef.current.find((door) => door.id === selectedIdRef.current)
        : undefined;
      const shouldReplaceUntouched =
        detail.replaceUntouched === true &&
        selectedPaneVisible &&
        isUntouched(selectedPaneId!);
      const shellName = detail.name?.trim() || 'terminal';

      if (shouldReplaceUntouched) {
        if (lath) {
          lath.replaceLeaf(selectedPaneId!, newId, terminalLeafMeta());
          disposeSession(selectedPaneId!);
        } else {
          const selectedPanel = api!.getPanel(selectedPaneId!)!;
          api!.addPanel({
            id: newId,
            component: 'terminal',
            tabComponent: 'terminal',
            title: UNNAMED_PANEL_TITLE,
            position: { referencePanel: selectedPanel, direction: 'within' },
          });
          disposeSession(selectedPaneId!);
          api!.removePanel(selectedPanel);
        }
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

      if (lath) {
        // dockview splits from the active panel; Lath splits from the selected pane
        // when it's a live pane, else the last leaf.
        const panes = lath.listPanes();
        const refId = selectedPaneVisible ? selectedPaneId! : (panes.length > 0 ? panes[panes.length - 1].id : null);
        lath.addLeaf(newId, terminalLeafMeta(), refId ? { refId, edge: lath.autoEdgeFor(refId) } : null);
      } else {
        const active = api!.activePanel;
        api!.addPanel({
          id: newId,
          component: 'terminal',
          tabComponent: 'terminal',
          title: UNNAMED_PANEL_TITLE,
          position: active ? { referencePanel: active.id, direction: pickSplitDirection(active) } : undefined,
        });
      }
      selectPane(newId);
      if (detail.announce) {
        showShellSpawnNotice(newId, `Opened ${shellName}`);
      }
    };
    window.addEventListener('dormouse:new-terminal', handler);
    return () => window.removeEventListener('dormouse:new-terminal', handler);
  }, [generatePaneId, selectPane, showShellSpawnNotice, lath]);

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

      const api = apiRef.current;
      if (!api && !lath) {
        detail.respond({ ok: false, error: 'Dormouse layout is not ready yet' });
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
        const visible = lath ? lath.has(target.value.id) : !!api!.getPanel(target.value.id);
        if (!visible) {
          detail.respond({ ok: false, error: `surface '${target.value.ref}' is not visible` });
          return null;
        }
        return { target: target.value };
      };

      // The `direction: 'auto'` aspect-ratio split resolution, per engine.
      const autoDorDirection = (id: string): DorResolvedSplitDirection =>
        lath ? dorDirectionForEdge(lath.autoEdgeFor(id)) : dorDirectionForDockview(pickSplitDirection(api!.getPanel(id)!));

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
          // it, so orchestrateKill's live selection check leaves the caller's
          // selection where ensure found it. A `--minimize` create is already a
          // door; killPaneImmediately tears the door down too — disposing the
          // session and removing it from the baseboard.
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
            if (lath) lath.updateParams(existing.id, refreshedParams);
            else api!.getPanel(existing.id)?.api.updateParameters(refreshedParams);
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
  }, [buildDorSurfaces, createContentSurface, createSplitSurface, findAgentBrowserSurface, findSurfaceIdRunningCommand, killPaneImmediately, resolveVisibleSurface, surfaceRefForId, lath]);

  const addSplitPanel = useCallback((
    id: string | null,
    direction: 'right' | 'below',
    splitDirection: 'horizontal' | 'vertical',
    source: 'keyboard' | 'mouse' = 'mouse',
  ) => {
    const api = apiRef.current;
    if (!api && !lath) return;
    const newId = generatePaneId();
    const ref = id && (lath ? lath.has(id) : !!api!.getPanel(id)) ? id : null;
    // Carry the currently-selected shell into the split, same as [+].
    const defaults = getDefaultShellOpts();
    // Remote cwds (OSC 7 over ssh) name a path on the remote host, not one the local shell can chdir to.
    const sourceCwd = ref ? getTerminalPaneState(ref).cwd : null;
    const inheritedCwd = sourceCwd && !sourceCwd.isRemote ? sourceCwd.path : undefined;
    if (defaults?.shell || inheritedCwd) {
      setPendingShellOpts(newId, { shell: defaults?.shell, args: defaults?.args, cwd: inheritedCwd });
    }
    // Horizontal split places the new pane to the right → reveal from its left edge.
    // Vertical split places it below → reveal from its top edge.
    freshlySpawnedRef.current.set(newId, direction === 'right' ? 'left' : 'top');
    if (lath) {
      const panes = lath.listPanes();
      const refId = ref ?? (panes.length > 0 ? panes[panes.length - 1].id : null);
      lath.addLeaf(newId, terminalLeafMeta(), refId ? { refId, edge: direction === 'right' ? 'right' : 'bottom' } : null);
    } else {
      api!.addPanel({
        id: newId,
        component: 'terminal',
        tabComponent: 'terminal',
        title: UNNAMED_PANEL_TITLE,
        position: ref ? { referencePanel: ref, direction } : undefined,
      });
    }
    selectPane(newId);
    onEventRef.current?.({ type: 'split', direction: splitDirection, source });
  }, [selectPane, generatePaneId, lath]);

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
      if (lath) {
        // Zoom is presentation state in the store (the tree is untouched). Toggle:
        // any leaf zoomed → unzoom; else zoom this leaf.
        const zoomedNow = lath.store.getSnapshot().zoomedId !== null;
        lath.setZoomed(zoomedNow ? null : id);
        setZoomed(!zoomedNow);
        return;
      }
      const api = apiRef.current;
      if (!api) return;
      if (api.hasMaximizedGroup()) {
        api.exitMaximizedGroup();
        setZoomed(false);
      } else {
        const panel = api.getPanel(id);
        if (panel) { api.maximizeGroup(panel); setZoomed(true); }
      }
    },
    onClickPanel: (id: string) => {
      setConfirmKill(null);
      enterTerminalMode(id);
    },
    onFocusPane: (id: string) => {
      setConfirmKill(null);
      // Visible pane → jump straight in; minimized (a door) → reattach first.
      const visible = lath ? lath.has(id) : !!apiRef.current?.getPanel(id);
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
        if (lath) lath.setTitle(id, trimmed);
        else apiRef.current?.getPanel(id)?.api.setTitle(trimmed);
      }
      setRenamingPaneId(null);
      return result;
    },
    onCancelRename: () => {
      setRenamingPaneId(null);
    },
    onSwapRenderMode: (id, mode) => {
      const api = apiRef.current;
      const visible = lath ? lath.has(id) : !!api?.getPanel(id);
      if (!visible) return;
      const params = (lath ? lath.getMeta(id)?.params : api?.getPanel(id)?.params) as Record<string, unknown> | undefined;
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
      if (!apiRef.current && !lath) return;
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
  }), [addSplitPanel, minimizePane, enterTerminalMode, exitTerminalMode, killPaneImmediately, replaceSurface, buildDorSurfaces, createContentSurface, lath]);
  const wallActionsRef = useRef(wallActions);
  wallActionsRef.current = wallActions;

  // Engine-directed writes for the pane props contract (docs/specs/tiling-engine.md
  // → "Pane props contract"): route a pane/header's title / params writes to the
  // engine's per-leaf metadata (Lath) or the backing dockview panel. Memoized so
  // the sink handed to panels via context keeps a stable identity. The render-swap
  // and wsPort-refresh param writes in Wall.tsx above route through the same engines.
  const paneWrite = useMemo<PaneWriteActions>(() => (lath ? {
    setTitle: (id, title) => lath.setTitle(id, title),
    updateParams: (id, patch) => lath.updateParams(id, patch),
  } : {
    setTitle: (id, title) => apiRef.current?.getPanel(id)?.api.setTitle(title),
    updateParams: (id, patch) => apiRef.current?.getPanel(id)?.api.updateParameters(patch),
  }), [lath]);

  useWallKeyboard({
    apiRef,
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
    killInProgressRef,
    overlayElRef,
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

  // LathHost surfaces `focusin` inside a leaf as an op proposal (there are no
  // activation events). Adopt it exactly like the dockview onDidActivePanelChange
  // listener: passthrough → enter the leaf if selection differs; command → move
  // selection onto it. Never during a kill.
  const onLeafFocused = useCallback((id: string) => {
    if (killInProgressRef.current) return;
    if (modeRef.current === 'passthrough') {
      if (selectedIdRef.current !== id) enterTerminalMode(id);
      return;
    }
    if (selectedTypeRef.current !== 'pane' || selectedIdRef.current !== id) selectPane(id);
  }, [enterTerminalMode, selectPane]);

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
          <FreshlySpawnedContext.Provider value={freshlySpawnedRef.current}>
          <DialogKeyboardContext.Provider value={setDialogKeyboardActive}>
          <div className="flex-1 min-h-0 flex flex-col bg-app-bg text-app-fg font-sans overflow-hidden">
            {/* Dockview — 2px bottom inset keeps rounded panes distinct from the baseboard when present. */}
            <div className={clsx('flex-1 min-h-0 relative px-1.5 pt-1.5', showBaseboard ? 'pb-0.5' : 'pb-1.5')}>
              <div ref={dockviewContainerRef} className={clsx('absolute inset-x-1.5 top-1.5', showBaseboard ? 'bottom-0.5' : 'bottom-1.5')}>
                {lath ? (
                  <LathHost
                    store={lath.store}
                    onCommitResize={(splitPath, boundary, deltaPx) => lath.store.resizeBoundary(splitPath, boundary, deltaPx)}
                    onLeafFocused={onLeafFocused}
                  />
                ) : (
                  <DockviewReact
                    components={components}
                    tabComponents={tabComponents}
                    onReady={handleReady}
                    theme={dormouseTheme}
                    singleTabMode="fullwidth"
                  />
                )}
                <WorkspaceSelectionOverlay apiRef={apiRef} lathStore={lath ? lath.store : null} selectedId={selectedId} selectedType={selectedType} mode={mode} overlayElRef={overlayElRef} />
              </div>
            </div>

            {/* Baseboard — always visible in the main shell; embedders may suppress it for constrained mobile prototypes. */}
            {showBaseboard ? (
              <Baseboard items={doors} onReattach={handleReattach} notice={baseboardNotice} />
            ) : null}

            {/* Kill confirmation overlay — centered over the pane being killed */}
            {confirmKill && (
              <KillConfirmOverlay
                apiRef={apiRef}
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
          </FreshlySpawnedContext.Provider>
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
