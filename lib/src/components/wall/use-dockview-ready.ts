import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type {
  DockviewApi,
  DockviewGroupPanel,
  DockviewReadyEvent,
  DockviewWillDropEvent,
  SerializedDockview,
} from 'dockview-react';
import { getDefaultShellOpts, setPendingShellOpts, swapTerminals, UNNAMED_PANEL_TITLE } from '../../lib/terminal-registry';
import { prefersReducedMotion } from '../../lib/ui-geometry';
import type { DooredItem, WallMode, WallSelectionKind, SpawnDirection } from './wall-types';
import { pickSplitDirection, swapPanelTitles } from './dockview-helpers';

export function useDockviewReady({
  apiRef,
  dockviewReadyInitializedRef,
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
}: {
  apiRef: RefObject<DockviewApi | null>;
  dockviewReadyInitializedRef: RefObject<boolean>;
  initialPaneIdsRef: RefObject<string[] | undefined>;
  restoredLayoutRef: RefObject<unknown>;
  initialDoorsRef: RefObject<DooredItem[]>;
  doorsRef: RefObject<DooredItem[]>;
  freshlySpawnedRef: RefObject<Map<string, SpawnDirection>>;
  killInProgressRef: RefObject<boolean>;
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
  return useCallback((e: DockviewReadyEvent) => {
    apiRef.current = e.api;
    setDockviewApi(e.api);
    if (dockviewReadyInitializedRef.current && e.api.totalPanels > 0) return;
    dockviewReadyInitializedRef.current = true;

    const restored = initialPaneIdsRef.current;
    const layout = restoredLayoutRef.current;
    const restoredDoors = initialDoorsRef.current;
    doorsRef.current = restoredDoors;
    setDoors(restoredDoors);

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

    if (layout && restored && restored.length > 0) {
      try {
        e.api.fromJSON(layout as SerializedDockview);
        setSelectedId(restored[0]);
      } catch {
        for (const id of restored) {
          addTerminalPanel(id);
        }
        setSelectedId(restored[0]);
      }
    } else {
      const paneIds = restored && restored.length > 0
        ? restored
        : [generatePaneId()];
      for (const id of paneIds) {
        addTerminalPanel(id);
      }
      setSelectedId(paneIds[0]);
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
        e.api.addPanel({ id, component: 'terminal', tabComponent: 'terminal', title: UNNAMED_PANEL_TITLE });
        if (selectedIdRef.current === null) {
          selectPane(id);
        }
      };
      setTimeout(spawn, delay);
    });

    onApiReady?.(e.api);
  }, [
    apiRef,
    dockviewReadyInitializedRef,
    doorsRef,
    enterTerminalModeRef,
    freshlySpawnedRef,
    generatePaneId,
    initialDoorsRef,
    initialPaneIdsRef,
    killInProgressRef,
    modeRef,
    onApiReady,
    restoredLayoutRef,
    selectPane,
    selectedIdRef,
    selectedTypeRef,
    setDockviewApi,
    setDoors,
    setSelectedId,
  ]);
}
