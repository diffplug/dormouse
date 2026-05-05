import { useRef, useState, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import {
  DockviewReact,
  themeAbyss,
  type DockviewTheme,
  type DockviewApi,
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { Baseboard } from './Baseboard';
import { KILL_CONFIRM_MS, KILL_SHAKE_MS, KillConfirmOverlay, randomKillChar, type ConfirmKill } from './KillConfirm';
import {
  clearSessionAttention,
  dismissOrToggleAlert,
  focusSession,
  markSessionAttention,
  toggleSessionTodo,
  setPendingShellOpts,
  getDefaultShellOpts,
  type SessionStatus,
} from '../lib/terminal-registry';
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
import type { DooredItem, WallEvent, WallMode, WallSelectionKind, SpawnDirection } from './wall/wall-types';

export type { DooredItem, WallEvent, WallMode, WallSelectionKind, SpawnDirection } from './wall/wall-types';
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

const mousetermTheme: DockviewTheme = {
  ...themeAbyss,
  name: 'mouseterm',
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

const components = { terminal: TerminalPanel };
const tabComponents = { terminal: TerminalPaneHeader };

// --- Main component ---

export function Wall({
  initialPaneIds,
  restoredLayout,
  initialDoors,
  onApiReady,
  onEvent,
  baseboardNotice,
}: {
  initialPaneIds?: string[];
  restoredLayout?: unknown;
  initialDoors?: PersistedDoor[];
  onApiReady?: (api: DockviewApi) => void;
  onEvent?: (event: WallEvent) => void;
  baseboardNotice?: ReactNode;
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
  const [mode, setMode] = useState<WallMode>('command');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<WallSelectionKind>('pane');

  const windowFocused = useWindowFocused();
  useDynamicPalette();

  // UI state
  const [confirmKill, setConfirmKill] = useState<ConfirmKill | null>(null);
  const [renamingPaneId, setRenamingPaneId] = useState<string | null>(null);
  const [doors, setDoors] = useState<DooredItem[]>(() => (initialDoors ?? []) as DooredItem[]);
  const [zoomed, setZoomed] = useState(false);

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
  }, []);

  // Confirm runs orchestrateKill concurrently with the letter flash so the
  // pane fade begins while the flash is still playing.
  const rejectKill = useCallback(() => {
    const ck = confirmKillRef.current;
    if (!ck || ck.exit) return;
    setConfirmKill({ ...ck, exit: 'shake' });
    shakeTimerRef.current = setTimeout(() => setConfirmKill(null), KILL_SHAKE_MS);
  }, []);
  const acceptKill = useCallback((onExit: () => void) => {
    const ck = confirmKillRef.current;
    if (!ck || ck.exit) return;
    setConfirmKill({ ...ck, exit: 'confirm' });
    onExit();
    onEventRef.current?.({ type: 'kill', id: ck.id });
    confirmTimerRef.current = setTimeout(() => setConfirmKill(null), KILL_CONFIRM_MS);
  }, []);

  // --- External event notifications ---
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const fireEvent = useCallback((event: WallEvent) => {
    onEventRef.current?.(event);
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
    const title = panel.title ?? id;
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
    options?: { enterPassthrough?: boolean; confirmKill?: boolean },
  ) => {
    const api = apiRef.current;
    if (!api) return;
    const enterPassthrough = options?.enterPassthrough ?? true;
    const confirmKillAfterRestore = options?.confirmKill ?? false;

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
        if (confirmKillAfterRestore) {
          setConfirmKill({ id: item.id, char: randomKillChar() });
        }
      });
    }
  }, [selectPane, enterTerminalMode]);
  const handleReattachRef = useRef(handleReattach);
  handleReattachRef.current = handleReattach;

  // Listen for external "new terminal" requests (e.g. from the standalone AppBar)
  useEffect(() => {
    const handler = (e: Event) => {
      const api = apiRef.current;
      if (!api) return;
      const detail = (e as CustomEvent).detail;
      const newId = generatePaneId();

      // Store shell options so getOrCreateTerminal picks them up on mount
      if (detail?.shell) {
        setPendingShellOpts(newId, { shell: detail.shell, args: detail.args });
      }

      const active = api.activePanel;
      api.addPanel({
        id: newId,
        component: 'terminal',
        tabComponent: 'terminal',
        title: '<unnamed>',
        position: active ? { referencePanel: active.id, direction: pickSplitDirection(active) } : undefined,
      });
      selectPane(newId);
    };
    window.addEventListener('mouseterm:new-terminal', handler);
    return () => window.removeEventListener('mouseterm:new-terminal', handler);
  }, [generatePaneId, selectPane]);

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
    if (defaults?.shell) {
      setPendingShellOpts(newId, { shell: defaults.shell, args: defaults.args });
    }
    // Horizontal split places the new pane to the right → reveal from its left edge.
    // Vertical split places it below → reveal from its top edge.
    freshlySpawnedRef.current.set(newId, direction === 'right' ? 'left' : 'top');
    api.addPanel({
      id: newId,
      component: 'terminal',
      tabComponent: 'terminal',
      title: '<unnamed>',
      position: ref ? { referencePanel: ref, direction } : undefined,
    });
    selectPane(newId);
    onEventRef.current?.({ type: 'split', direction: splitDirection, source });
  }, [selectPane, generatePaneId]);

  // --- Wall actions (for tab buttons) ---

  const wallActions: WallActions = useMemo(() => ({
    onKill: (id: string) => {
      exitTerminalMode();
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
      if (trimmed) {
        apiRef.current?.getPanel(id)?.api.setTitle(trimmed);
      }
      setRenamingPaneId(null);
    },
    onCancelRename: () => {
      setRenamingPaneId(null);
    },
  }), [addSplitPanel, minimizePane, enterTerminalMode, exitTerminalMode]);
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
            {/* Dockview — 2px bottom inset keeps rounded panes distinct from the baseboard. */}
            <div className="flex-1 min-h-0 relative px-1.5 pt-1.5 pb-0.5">
              <div ref={dockviewContainerRef} className="absolute inset-x-1.5 top-1.5 bottom-0.5">
                <DockviewReact
                  components={components}
                  tabComponents={tabComponents}
                  onReady={handleReady}
                  theme={mousetermTheme}
                  singleTabMode="fullwidth"
                />
                <WorkspaceSelectionOverlay apiRef={apiRef} selectedId={selectedId} selectedType={selectedType} mode={mode} overlayElRef={overlayElRef} />
              </div>
            </div>

            {/* Baseboard — always visible */}
            <Baseboard items={doors} onReattach={handleReattach} notice={baseboardNotice} />

            {/* Kill confirmation overlay — centered over the pane being killed */}
            {confirmKill && (
              <KillConfirmOverlay
                confirmKill={confirmKill}
                paneElements={paneElements}
                onCancel={() => rejectKill()}
              />
            )}

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
