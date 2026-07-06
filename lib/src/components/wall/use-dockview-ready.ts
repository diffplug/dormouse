import { useCallback, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type {
  DockviewApi,
  DockviewGroupPanel,
  DockviewReadyEvent,
  DockviewWillDropEvent,
  SerializedDockview,
} from 'dockview-react';
import { getDefaultShellOpts, setPendingShellOpts, swapTerminals, UNNAMED_PANEL_TITLE } from '../../lib/terminal-registry';
import { prefersReducedMotion } from '../../lib/ui-geometry';
import { withProgrammaticActivation } from '../../lib/programmatic-activation';
import type { DooredItem, WallMode, WallSelectionKind, SpawnDirection } from './wall-types';
import { pickSplitDirection, swapPanelTitles } from './dockview-helpers';

export function useDockviewReady({
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
}: {
  apiRef: RefObject<DockviewApi | null>;
  initialPaneIdsRef: RefObject<string[] | undefined>;
  restoredLayoutRef: RefObject<unknown>;
  initialDoorsRef: RefObject<DooredItem[]>;
  doorsRef: RefObject<DooredItem[]>;
  freshlySpawnedRef: RefObject<Map<string, SpawnDirection>>;
  killInProgressRef: RefObject<boolean>;
  programmaticActivationRef: RefObject<number>;
  selectedIdRef: RefObject<string | null>;
  selectedTypeRef: RefObject<WallSelectionKind>;
  modeRef: RefObject<WallMode>;
  enterTerminalModeRef: RefObject<(id: string) => void>;
  generatePaneId: () => string;
  selectPane: (id: string) => void;
  setDockviewApi: Dispatch<SetStateAction<DockviewApi | null>>;
  setDoors: Dispatch<SetStateAction<DooredItem[]>>;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  onApiReady?: (api: DockviewApi) => void;
}): (event: DockviewReadyEvent) => void {
  // handleReady must be idempotent across a dockview remount. React StrictMode
  // (dev) mounts dockview → fires onReady → disposes it → mounts a fresh dockview
  // → fires onReady AGAIN, on the same Wall instance (so these refs persist).
  // Consuming the initial ids/layout on the first pass would leave the surviving
  // second dockview with nothing to restore — it would fall back to a freshly
  // generated pane id, dropping the restored session and (in the website
  // playground) the pane that onApiReady's addPanel references. So resolve the
  // restoration once and cache it; every onReady replays the same result.
  const resolvedRef = useRef<{ mode: 'layout' | 'panes'; paneIds: string[] } | null>(null);

  return useCallback((e: DockviewReadyEvent) => {
    apiRef.current = e.api;
    setDockviewApi(e.api);

    const layout = restoredLayoutRef.current;
    const restoredDoors = initialDoorsRef.current;
    doorsRef.current = restoredDoors;
    setDoors(restoredDoors);

    let resolution = resolvedRef.current;
    if (!resolution) {
      const restored = initialPaneIdsRef.current;
      const hasRestored = !!restored && restored.length > 0;
      resolution = layout && hasRestored
        ? { mode: 'layout', paneIds: restored! }
        : { mode: 'panes', paneIds: hasRestored ? restored! : [generatePaneId()] };
      resolvedRef.current = resolution;
    }

    const primeDefaultShell = (id: string) => {
      const defaults = getDefaultShellOpts();
      if (defaults?.shell) {
        setPendingShellOpts(id, { shell: defaults.shell, args: defaults.args });
      }
    };

    const addTerminalPanel = (id: string) => {
      primeDefaultShell(id);
      const referencePanel = e.api.panels[e.api.panels.length - 1] ?? null;
      const direction = pickSplitDirection(referencePanel);
      e.api.addPanel({
        id,
        component: 'terminal',
        tabComponent: 'terminal',
        title: UNNAMED_PANEL_TITLE,
        position: referencePanel ? { referencePanel: referencePanel.id, direction } : undefined,
      });
    };

    if (resolution.mode === 'layout') {
      try {
        e.api.fromJSON(layout as SerializedDockview);
        setSelectedId(resolution.paneIds[0]);
      } catch {
        for (const id of resolution.paneIds) {
          addTerminalPanel(id);
        }
        setSelectedId(resolution.paneIds[0]);
      }
    } else {
      for (const id of resolution.paneIds) {
        addTerminalPanel(id);
      }
      setSelectedId(resolution.paneIds[0]);
    }

    e.api.onWillShowOverlay((event) => {
      if (event.kind === 'tab') {
        event.preventDefault();
      }
    });

    const subscribeGroupDrop = (group: DockviewGroupPanel) => {
      return group.model.onWillDrop((event: DockviewWillDropEvent) => {
        if (event.position === 'center') {
          const data = event.getData();
          let draggedId: string | null = data?.panelId ?? null;
          if (!draggedId && data?.groupId) {
            const draggedGroup = e.api.getGroup(data.groupId);
            draggedId = draggedGroup?.activePanel?.id ?? null;
          }
          const targetPanel = group.activePanel;
          if (draggedId && targetPanel && draggedId !== targetPanel.id) {
            swapTerminals(draggedId, targetPanel.id);
            swapPanelTitles(e.api, draggedId, targetPanel.id);
            selectPane(targetPanel.id);
          }
          event.preventDefault();
        }
      });
    };
    for (const group of e.api.groups) {
      subscribeGroupDrop(group);
    }
    e.api.onDidAddGroup((group) => {
      subscribeGroupDrop(group);
    });

    e.api.onDidActivePanelChange((panel) => {
      if (panel) {
        // A programmatic add-side mutation is mid-flight (focus-neutral create,
        // etc.): it briefly activates the new pane so dockview renders it, then
        // hands activation back to the caller. That activation churn is not user
        // intent, so selection/mode stay put — see programmatic-activation.ts.
        if (programmaticActivationRef.current > 0) return;
        if (selectedTypeRef.current === 'door') return;
        if (modeRef.current === 'passthrough' && selectedIdRef.current !== panel.id) {
          enterTerminalModeRef.current(panel.id);
          return;
        }
        setSelectedId(panel.id);
      }
    });

    e.api.onDidRemovePanel(() => {
      if (e.api.totalPanels !== 0) return;
      const delay = (prefersReducedMotion() || killInProgressRef.current) ? 0 : 440;
      const spawn = () => {
        if (e.api.totalPanels > 0) return;
        const id = generatePaneId();
        primeDefaultShell(id);
        freshlySpawnedRef.current.set(id, 'top-left');
        withProgrammaticActivation(programmaticActivationRef, () => {
          e.api.addPanel({ id, component: 'terminal', tabComponent: 'terminal', title: UNNAMED_PANEL_TITLE });
        });
        // Adopt the replacement only when the current selection no longer points at
        // anything real: null (the kill tail cleared it) or dangling (selection still
        // names the removed pane — the 0ms kill timer can beat React's flush of
        // setSelectedId(null) into selectedIdRef). A valid selection keeps it: a door
        // (just-minimized last pane, corner case #11) or a live pane stays selected —
        // the auto-spawn exists to keep a pane visible, not to steal selection.
        const sel = selectedIdRef.current;
        const selDangling = sel !== null && selectedTypeRef.current === 'pane' && !e.api.getPanel(sel);
        if (sel === null || selDangling) selectPane(id);
      };
      setTimeout(spawn, delay);
    });

    onApiReady?.(e.api);
  }, [
    apiRef,
    doorsRef,
    enterTerminalModeRef,
    freshlySpawnedRef,
    generatePaneId,
    initialDoorsRef,
    initialPaneIdsRef,
    killInProgressRef,
    modeRef,
    onApiReady,
    resolvedRef,
    restoredLayoutRef,
    selectPane,
    programmaticActivationRef,
    selectedIdRef,
    selectedTypeRef,
    setDockviewApi,
    setDoors,
    setSelectedId,
  ]);
}
