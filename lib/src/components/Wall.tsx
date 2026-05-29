import { useRef, useState, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import { clsx } from 'clsx';
import {
  DockviewReact,
  themeAbyss,
  type DockviewTheme,
  type DockviewApi,
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { Baseboard } from './Baseboard';
import { ExternalLinkModalHost } from './ExternalLinkModalHost';
import { KILL_CONFIRM_MS, KILL_SHAKE_MS, KillConfirmOverlay, randomKillChar, type ConfirmKill } from './KillConfirm';
import {
  clearSessionAttention,
  disposeSession,
  dismissOrToggleAlert,
  focusSession,
  markSessionAttention,
  toggleSessionTodo,
  setPendingShellOpts,
  getDefaultShellOpts,
  getTerminalPaneState,
  getTerminalPaneStateSnapshot,
  getActivitySnapshot,
  isUntouched,
  getOrCreateTerminal,
  getTerminalInstance,
  isReservedUserTitle,
  setTerminalUserTitle,
  UNNAMED_PANEL_TITLE,
  type SessionStatus,
} from '../lib/terminal-registry';
import {
  buildAppTitleResolver,
  createTerminalPaneState,
  deriveHeader,
  resolveDisplayPrimary,
} from '../lib/terminal-state';
import { orchestrateKill } from '../lib/kill-animation';
import { getPlatform, PLATFORM_STRING } from '../lib/platform';
import type { DorControlRequestPayload, DorControlResult } from 'dor/protocol';
import type {
  Surface as DorSurface,
  SplitDirection as DorSplitDirection,
  ResolvedSplitDirection as DorResolvedSplitDirection,
  ParseResult,
} from 'dor/commands/types';
import { findReattachNeighbor } from '../lib/spatial-nav';
import { cloneLayout, getLayoutStructureSignature } from '../lib/layout-snapshot';
import type { PersistedDoor } from '../lib/session-types';
import { useDynamicPalette } from '../lib/themes/use-dynamic-palette';
import { TerminalPanel } from './wall/TerminalPanel';
import { TerminalPaneHeader } from './wall/TerminalPaneHeader';
import { WorkspaceSelectionOverlay } from './wall/WorkspaceSelectionOverlay';
import { useDockviewReady } from './wall/use-dockview-ready';
import { pickSplitDirection } from './wall/dockview-helpers';
import { useWallKeyboard } from './wall/use-wall-keyboard';
import { useSessionPersistence } from './wall/use-session-persistence';
import { useWindowFocused } from './wall/use-window-focused';
import {
  DialogKeyboardContext,
  DoorElementsContext,
  FreshlySpawnedContext,
  ModeContext,
  PaneElementsContext,
  WallActionsContext,
  RenamingIdContext,
  SelectedIdContext,
  WindowFocusedContext,
  ZoomedContext,
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
  direction?: unknown;
  input?: unknown;
  inputCount?: unknown;
  lines?: unknown;
  minimized?: unknown;
  pane?: string;
  surface?: unknown;
  title?: unknown;
  workspace?: string;
  window?: string;
  scrollback?: unknown;
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

function numberParam(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function limitLines(text: string, lines: number | undefined): string {
  if (lines === undefined) return text;
  const parts = text.split('\n');
  return parts.slice(-lines).join('\n');
}

function readVisibleSurfaceText(surfaceId: string, lines: number | undefined): string {
  const terminal = getTerminalInstance(surfaceId);
  if (!terminal) return '';

  const buffer = terminal.buffer.active;
  const start = Math.max(0, buffer.viewportY);
  const end = start + terminal.rows;
  const visibleLines: string[] = [];
  for (let row = start; row < end; row += 1) {
    visibleLines.push(buffer.getLine(row)?.translateToString(true) ?? '');
  }

  return limitLines(visibleLines.join('\n').replace(/\n+$/, ''), lines);
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

function titleFromCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

function validateUserTitle(title: string): string | null {
  const trimmed = title.trim();
  if (!trimmed) return 'title cannot be empty';
  if (isReservedUserTitle(trimmed)) return 'title is reserved';
  return null;
}

function hostLooksWindows(): boolean {
  return /win/i.test(PLATFORM_STRING);
}

function commandShellArgs(shell: string | undefined, command: string): string[] {
  const normalizedShell = (shell ?? '').replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  if (!normalizedShell && hostLooksWindows()) {
    return ['/d', '/s', '/c', command];
  }
  if (normalizedShell === 'cmd.exe' || normalizedShell === 'cmd') {
    return ['/d', '/s', '/c', command];
  }
  if (normalizedShell === 'powershell.exe' || normalizedShell === 'powershell' || normalizedShell === 'pwsh.exe' || normalizedShell === 'pwsh') {
    return ['-NoLogo', '-NoProfile', '-Command', command];
  }
  return ['-lc', command];
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

const components = { terminal: TerminalPanel };
const tabComponents = { terminal: TerminalPaneHeader };

// --- Main component ---

export function Wall({
  initialPaneIds,
  initialMode = 'command',
  restoredLayout,
  initialDoors,
  onApiReady,
  onEvent,
  baseboardNotice,
  showBaseboard = true,
}: {
  initialPaneIds?: string[];
  initialMode?: WallMode;
  restoredLayout?: unknown;
  initialDoors?: PersistedDoor[];
  onApiReady?: (api: DockviewApi) => void;
  onEvent?: (event: WallEvent) => void;
  baseboardNotice?: ReactNode;
  showBaseboard?: boolean;
} = {}) {
  const apiRef = useRef<DockviewApi | null>(null);
  const [dockviewApi, setDockviewApi] = useState<DockviewApi | null>(null);
  const dockviewContainerRef = useRef<HTMLDivElement | null>(null);

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
    const panel = apiRef.current?.getPanel(id);
    if (panel) panel.api.setActive();
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
    if (!api?.getPanel(id)) return;
    orchestrateKill(api, id, selectPane, setSelectedId, killInProgressRef, overlayElRef);
    fireEvent({ type: 'kill', id });
  }, [fireEvent, selectPane]);

  const acceptKill = useCallback(() => {
    const ck = confirmKillRef.current;
    if (!ck || ck.exit) return;
    setConfirmKill({ ...ck, exit: 'confirm' });
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
    if (panel) panel.api.setActive();
  }, []);
  const enterTerminalModeRef = useRef(enterTerminalMode);
  enterTerminalModeRef.current = enterTerminalMode;

  /** Minimize a pane: capture neighbor context, remove from dockview, add to doors state */
  const minimizePane = useCallback((id: string) => {
    const api = apiRef.current;
    if (!api) return;
    const panel = api.getPanel(id);
    if (!panel) return;
    const title = persistedPanelTitle(panel.title);
    const layoutAtMinimize = cloneLayout(api.toJSON());

    // Capture the nearest adjacent pane and our actual relative position
    // so immediate restore can reconstruct the original split precisely.
    const { neighborId, direction } = findReattachNeighbor(id, api, paneElements);

    const remainingPaneIds = api.panels
      .filter(p => p.id !== id)
      .map(p => p.id)
      .sort();

    api.removePanel(panel);
    clearSessionAttention(id);
    const layoutAtMinimizeSignature = getLayoutStructureSignature(api.toJSON());
    const nextDoors = [...doorsRef.current, {
      id,
      title,
      neighborId,
      direction,
      remainingPaneIds,
      layoutAtMinimize,
      layoutAtMinimizeSignature,
    }];
    doorsRef.current = nextDoors;
    setDoors(nextDoors);

    // Keep the minimized session selected as a door so the user can track where it went.
    modeRef.current = 'command';
    setMode('command');
    selectDoor(id);
  }, [selectDoor]);

  /** Exit terminal mode */
  const exitTerminalMode = useCallback(() => {
    modeRef.current = 'command';
    setMode('command');
    const id = selectedIdRef.current;
    if (id) focusSession(id, false);
  }, []);

  useEffect(() => {
    const handleBlur = () => clearSessionAttention();
    window.addEventListener('blur', handleBlur);
    return () => window.removeEventListener('blur', handleBlur);
  }, []);

  const handleReady = useDockviewReady({
    apiRef,
    initialPaneIdsRef,
    restoredLayoutRef,
    initialDoorsRef,
    doorsRef,
    freshlySpawnedRef,
    killInProgressRef,
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

  // --- Session persistence ---
  useSessionPersistence({
    dockviewApi,
    apiRef,
    doorsRef,
    selectedIdRef,
    selectedTypeRef,
  });

  // --- Reattach ---

  const handleReattach = useCallback((
    item: DooredItem,
    options?: { enterPassthrough?: boolean; afterRestore?: DoorAfterRestoreAction },
  ) => {
    const api = apiRef.current;
    if (!api) return;
    const enterPassthrough = options?.enterPassthrough ?? true;
    const afterRestore = options?.afterRestore;

    const currentLayoutSignature = getLayoutStructureSignature(api.toJSON());
    // Exact reattach is only safe when the layout structure matches AND the
    // current panes are the same ones that existed when we minimized. If new
    // panes were auto-spawned (e.g. last pane minimized → auto-create), the
    // layoutAtMinimize would destroy them.
    const currentPaneIds = api.panels.map(p => p.id).sort();
    const reattachPaneIds = item.layoutAtMinimize
      ? Object.keys(item.layoutAtMinimize.panels).filter(id => id !== item.id).sort()
      : [];
    const canReattachExactLayout =
      !!item.layoutAtMinimize &&
      currentLayoutSignature === item.layoutAtMinimizeSignature &&
      idsMatch(currentPaneIds, reattachPaneIds);

    if (canReattachExactLayout) {
      const currentTitles = new Map(
        api.panels.map(panel => [panel.id, panel.title ?? panel.id] as const),
      );

      // reuseExistingPanels: keep existing panel component instances mounted
      // rather than destroying and recreating them during deserialization.
      api.fromJSON(cloneLayout(item.layoutAtMinimize!), { reuseExistingPanels: true });

      for (const [panelId, title] of currentTitles) {
        if (panelId === item.id) continue;
        api.getPanel(panelId)?.api.setTitle(title);
      }
    } else {
      const currentIds = api.panels.map(p => p.id).sort();
      const layoutUnchanged =
        item.neighborId &&
        api.getPanel(item.neighborId) &&
        idsMatch(currentIds, item.remainingPaneIds);

      if (layoutUnchanged) {
        // Restore to original position next to the same neighbor
        api.addPanel({
          id: item.id,
          component: 'terminal',
          tabComponent: 'terminal',
          title: item.title,
          position: { referencePanel: item.neighborId!, direction: item.direction },
        });
      } else {
        // Layout changed — split an existing panel based on its aspect ratio
        const sid = selectedIdRef.current;
        const refPanel = (sid && api.getPanel(sid)) ?? api.panels[0] ?? null;
        api.addPanel({
          id: item.id,
          component: 'terminal',
          tabComponent: 'terminal',
          title: item.title,
          position: refPanel ? { referencePanel: refPanel.id, direction: pickSplitDirection(refPanel) } : undefined,
        });
      }
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
        // Guard against panel removal between scheduling and execution
        if (!apiRef.current?.getPanel(item.id)) return;
        focusSession(item.id, false);
        if (afterRestore === 'kill-immediately') {
          killPaneImmediately(item.id);
        } else if (afterRestore === 'confirm-kill') {
          setConfirmKill({ id: item.id, char: randomKillChar() });
        } else if (typeof afterRestore === 'object' && afterRestore.type === 'replace-terminal') {
          const panel = apiRef.current?.getPanel(item.id);
          if (!panel) return;
          apiRef.current?.addPanel({
            id: afterRestore.newId,
            component: 'terminal',
            tabComponent: 'terminal',
            title: UNNAMED_PANEL_TITLE,
            position: { referencePanel: panel, direction: 'within' },
          });
          disposeSession(item.id);
          apiRef.current?.removePanel(panel);
          selectPane(afterRestore.newId);
          if (afterRestore.announce) {
            showShellSpawnNotice(afterRestore.newId, `Switched to ${afterRestore.shellName}`);
          }
        }
      });
    }
  }, [selectPane, enterTerminalMode, killPaneImmediately, showShellSpawnNotice]);
  const handleReattachRef = useRef(handleReattach);
  handleReattachRef.current = handleReattach;

  const buildDorSurfaces = useCallback((api: DockviewApi): DorSurface[] => {
    const panels = api.panels;
    const activeId = api.activePanel?.id ?? (selectedTypeRef.current === 'pane' ? selectedIdRef.current : null);
    const terminalStates = getTerminalPaneStateSnapshot();
    const activityStates = getActivitySnapshot();
    const appTitleForPane = buildAppTitleResolver(terminalStates, activityStates);
    const panelStates = panels.map((panel) => terminalStates.get(panel.id) ?? createTerminalPaneState());

    return panels.map((panel, index) => {
      const state = panelStates[index] ?? createTerminalPaneState();
      const derived = deriveHeader(state, panelStates, { appTitleForPane });
      const title = resolveDisplayPrimary(derived.primary, panel.title ?? panel.id);

      return {
        id: panel.id,
        ref: `surface:${index + 1}`,
        paneRef: `pane:${index + 1}`,
        type: 'terminal',
        title,
        focused: panel.id === activeId,
        index,
        indexInPane: 0,
        requestedWorkingDirectory: state.cwd?.path ?? null,
        selectedInPane: true,
      };
    });
  }, []);

  const surfaceRefForId = useCallback((id: string): string => {
    const api = apiRef.current;
    const panelIndex = api?.panels.findIndex((panel) => panel.id === id) ?? -1;
    if (panelIndex >= 0) return `surface:${panelIndex + 1}`;
    const doorIndex = doorsRef.current.findIndex((door) => door.id === id);
    const visibleCount = api?.panels.length ?? 0;
    if (doorIndex >= 0) return `surface:${visibleCount + doorIndex + 1}`;
    return id;
  }, []);

  const resolveVisibleSurface = useCallback((
    api: DockviewApi,
    target: string | undefined,
    callerSurfaceId: string | undefined,
  ): ParseResult<DorSurface> => {
    const surfaces = buildDorSurfaces(api);
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

  const findSurfaceIdByUserTitle = useCallback((title: string): string | null => {
    const ids = [
      ...(apiRef.current?.panels.map((panel) => panel.id) ?? []),
      ...doorsRef.current.map((door) => door.id),
    ];
    return ids.find((id) => getTerminalPaneState(id).titleCandidates.user?.title.trim() === title) ?? null;
  }, []);

  const createSplitSurface = useCallback(({
    command,
    direction,
    minimized,
    referenceId,
    title,
  }: {
    command?: string;
    direction: DorResolvedSplitDirection;
    minimized: boolean;
    referenceId: string;
    title?: string;
  }): ParseResult<{
    id: string;
    ref: string;
  }> => {
    const api = apiRef.current;
    if (!api) return { ok: false, message: 'Dormouse layout is not ready yet' };
    const referencePanel = api.getPanel(referenceId);
    if (!referencePanel) return { ok: false, message: `surface '${referenceId}' is not visible` };

    if (title) {
      const titleError = validateUserTitle(title);
      if (titleError) return { ok: false, message: titleError };
    }

    const newId = generatePaneId();
    const defaults = getDefaultShellOpts();
    const sourceCwd = getTerminalPaneState(referencePanel.id).cwd;
    const inheritedCwd = sourceCwd && !sourceCwd.isRemote ? sourceCwd.path : undefined;

    if (command) {
      setPendingShellOpts(newId, {
        shell: defaults?.shell,
        args: commandShellArgs(defaults?.shell, command),
        cwd: inheritedCwd,
        title,
        untouched: false,
      });
    } else if (defaults?.shell || inheritedCwd || title) {
      setPendingShellOpts(newId, {
        shell: defaults?.shell,
        args: defaults?.args,
        cwd: inheritedCwd,
        title,
      });
    }

    if (title) {
      const result = setTerminalUserTitle(newId, title);
      if (!result.accepted) return { ok: false, message: `title is ${result.reason}` };
    }

    const dockDirection = dockviewDirectionForDor(direction);
    freshlySpawnedRef.current.set(newId, spawnDirectionForDockview(dockDirection));
    api.addPanel({
      id: newId,
      component: 'terminal',
      tabComponent: 'terminal',
      title: title ?? UNNAMED_PANEL_TITLE,
      position: { referencePanel: referencePanel.id, direction: dockDirection },
    });
    selectPane(newId);
    if (title) api.getPanel(newId)?.api.setTitle(title);
    onEventRef.current?.({
      type: 'split',
      direction: direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical',
      source: 'dor',
    });
    if (minimized) {
      getOrCreateTerminal(newId);
      minimizePane(newId);
    }
    return { ok: true, value: { id: newId, ref: surfaceRefForId(newId) } };
  }, [generatePaneId, minimizePane, selectPane, surfaceRefForId]);

  // Listen for external "new terminal" requests (e.g. from the standalone AppBar)
  useEffect(() => {
    const handler = (e: Event) => {
      const api = apiRef.current;
      if (!api) return;
      const detail = ((e as CustomEvent<ShellSpawnRequest>).detail ?? {}) as ShellSpawnRequest;
      const newId = generatePaneId();

      // Store shell options so getOrCreateTerminal picks them up on mount
      if (detail?.shell) {
        setPendingShellOpts(newId, { shell: detail.shell, args: detail.args });
      }

      const selectedPaneId = selectedTypeRef.current === 'pane' ? selectedIdRef.current : null;
      const selectedPanel = selectedPaneId ? api.getPanel(selectedPaneId) : undefined;
      const selectedDoor = selectedTypeRef.current === 'door'
        ? doorsRef.current.find((door) => door.id === selectedIdRef.current)
        : undefined;
      const shouldReplaceUntouched =
        detail.replaceUntouched === true &&
        !!selectedPaneId &&
        !!selectedPanel &&
        isUntouched(selectedPaneId);
      const shellName = detail.name?.trim() || 'terminal';

      if (shouldReplaceUntouched) {
        api.addPanel({
          id: newId,
          component: 'terminal',
          tabComponent: 'terminal',
          title: UNNAMED_PANEL_TITLE,
          position: { referencePanel: selectedPanel, direction: 'within' },
        });
        disposeSession(selectedPaneId);
        api.removePanel(selectedPanel);
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

      const active = api.activePanel;
      api.addPanel({
        id: newId,
        component: 'terminal',
        tabComponent: 'terminal',
        title: UNNAMED_PANEL_TITLE,
        position: active ? { referencePanel: active.id, direction: pickSplitDirection(active) } : undefined,
      });
      selectPane(newId);
      if (detail.announce) {
        showShellSpawnNotice(newId, `Opened ${shellName}`);
      }
    };
    window.addEventListener('dormouse:new-terminal', handler);
    return () => window.removeEventListener('dormouse:new-terminal', handler);
  }, [generatePaneId, selectPane, showShellSpawnNotice]);

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
      if (!api) {
        detail.respond({ ok: false, error: 'Dormouse layout is not ready yet' });
        return;
      }

      // Resolve the split reference surface and its live panel, responding with
      // the appropriate error and returning null when either is unavailable.
      const resolveSplitTarget = () => {
        const target = resolveVisibleSurface(api, stringParam(params.surface), detail.surfaceId);
        if (!target.ok) {
          detail.respond({ ok: false, error: target.message });
          return null;
        }
        const panel = api.getPanel(target.value.id);
        if (!panel) {
          detail.respond({ ok: false, error: `surface '${target.value.ref}' is not visible` });
          return null;
        }
        return { target: target.value, panel };
      };

      if (detail.method === 'surface.list') {
        const surfaces = buildDorSurfaces(api);
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

      if (detail.method === 'surface.split') {
        const directionParam = parseDorSplitDirection(params.direction);
        if (!directionParam) {
          detail.respond({ ok: false, error: `invalid split direction '${String(params.direction)}'` });
          return;
        }
        const resolved = resolveSplitTarget();
        if (!resolved) return;
        const direction = directionParam === 'auto'
          ? dorDirectionForDockview(pickSplitDirection(resolved.panel))
          : directionParam;
        const rawCommand = stringParam(params.command);
        const command = rawCommand?.trim() || undefined;
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

      if (detail.method === 'surface.ensure') {
        const command = stringParam(params.command)?.trim();
        if (!command) {
          detail.respond({ ok: false, error: 'command cannot be empty' });
          return;
        }
        const title = (stringParam(params.title)?.trim() || titleFromCommand(command));
        const titleError = validateUserTitle(title);
        if (titleError) {
          detail.respond({ ok: false, error: titleError });
          return;
        }
        const existingId = findSurfaceIdByUserTitle(title);
        if (existingId) {
          detail.respond({
            ok: true,
            result: {
              status: 'existing',
              surfaceId: existingId,
              surfaceRef: surfaceRefForId(existingId),
              title,
              command,
              minimized: doorsRef.current.some((door) => door.id === existingId),
            },
          });
          return;
        }
        const resolved = resolveSplitTarget();
        if (!resolved) return;
        const direction = dorDirectionForDockview(pickSplitDirection(resolved.panel));
        const result = createSplitSurface({
          command,
          direction,
          minimized: booleanParam(params.minimized),
          referenceId: resolved.target.id,
          title,
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
            title,
            command,
            minimized: booleanParam(params.minimized),
          },
        });
        return;
      }

      if (detail.method === 'surface.send') {
        const input = stringParam(params.input);
        if (input === undefined) {
          detail.respond({ ok: false, error: 'input is required' });
          return;
        }
        const target = resolveVisibleSurface(api, stringParam(params.surface), detail.surfaceId);
        if (!target.ok) {
          detail.respond({ ok: false, error: target.message });
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

      if (detail.method === 'surface.read') {
        const target = resolveVisibleSurface(api, stringParam(params.surface), detail.surfaceId);
        if (!target.ok) {
          detail.respond({ ok: false, error: target.message });
          return;
        }
        const lines = numberParam(params.lines);
        const scrollback = booleanParam(params.scrollback);
        const text = scrollback
          ? limitLines((await getPlatform().getScrollback(target.value.id)) ?? '', lines)
          : readVisibleSurfaceText(target.value.id, lines);
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

      detail.respond({ ok: false, error: `unsupported Dormouse control method '${detail.method}'` });
    };

    window.addEventListener('dormouse:control-request', handler);
    return () => window.removeEventListener('dormouse:control-request', handler);
  }, [buildDorSurfaces, createSplitSurface, findSurfaceIdByUserTitle, resolveVisibleSurface, surfaceRefForId]);

  const addSplitPanel = useCallback((
    id: string | null,
    direction: 'right' | 'below',
    splitDirection: 'horizontal' | 'vertical',
    source: 'keyboard' | 'mouse' = 'mouse',
  ) => {
    const api = apiRef.current;
    if (!api) return;
    const newId = generatePaneId();
    const ref = id && api.getPanel(id) ? id : null;
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
    api.addPanel({
      id: newId,
      component: 'terminal',
      tabComponent: 'terminal',
      title: UNNAMED_PANEL_TITLE,
      position: ref ? { referencePanel: ref, direction } : undefined,
    });
    selectPane(newId);
    onEventRef.current?.({ type: 'split', direction: splitDirection, source });
  }, [selectPane, generatePaneId]);

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
        apiRef.current?.getPanel(id)?.api.setTitle(trimmed);
      }
      setRenamingPaneId(null);
      return result;
    },
    onCancelRename: () => {
      setRenamingPaneId(null);
    },
  }), [addSplitPanel, minimizePane, enterTerminalMode, exitTerminalMode, killPaneImmediately]);
  const wallActionsRef = useRef(wallActions);
  wallActionsRef.current = wallActions;

  useWallKeyboard({
    apiRef,
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

  // --- Render ---

  return (
    <ModeContext.Provider value={mode}>
      <SelectedIdContext.Provider value={selectedId}>
        <WallActionsContext.Provider value={wallActions}>
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
                <DockviewReact
                  components={components}
                  tabComponents={tabComponents}
                  onReady={handleReady}
                  theme={dormouseTheme}
                  singleTabMode="fullwidth"
                />
                <WorkspaceSelectionOverlay apiRef={apiRef} selectedId={selectedId} selectedType={selectedType} mode={mode} overlayElRef={overlayElRef} />
              </div>
            </div>

            {/* Baseboard — always visible in the main shell; embedders may suppress it for constrained mobile prototypes. */}
            {showBaseboard ? (
              <Baseboard items={doors} onReattach={handleReattach} notice={baseboardNotice} />
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

          </div>
          </DialogKeyboardContext.Provider>
          </FreshlySpawnedContext.Provider>
          </WindowFocusedContext.Provider>
          </ZoomedContext.Provider>
          </RenamingIdContext.Provider>
          </DoorElementsContext.Provider>
          </PaneElementsContext.Provider>
        </WallActionsContext.Provider>
      </SelectedIdContext.Provider>
    </ModeContext.Provider>
  );
}
