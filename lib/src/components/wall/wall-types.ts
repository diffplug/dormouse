import type { SerializedDockview } from 'dockview-react';
import type { PersistedDoor } from '../../lib/session-types';

export type DooredItem = Omit<PersistedDoor, 'layoutAtMinimize'> & {
  layoutAtMinimize: SerializedDockview | null;
};

/** Engine-neutral visible-pane projection (dockview: `api.panels`; Lath:
 *  `lath.listPanes()`). Shared by the Wall helpers, dev-server correlation, and
 *  session persistence so they never touch the tiling engine directly. */
export type VisiblePane = { id: string; title: string | undefined; params: Record<string, unknown> | undefined };

export type WallMode = 'command' | 'passthrough';

export type WallSelectionKind = 'pane' | 'door';

export type DoorAfterRestoreAction =
  | 'confirm-kill'
  | 'kill-immediately'
  | {
      type: 'replace-terminal';
      newId: string;
      shellName: string;
      announce: boolean;
    };

export type WallEvent =
  | { type: 'modeChange'; mode: WallMode }
  | { type: 'zoomChange'; zoomed: boolean }
  | { type: 'minimizeChange'; count: number }
  | { type: 'split'; direction: 'horizontal' | 'vertical'; source: 'keyboard' | 'mouse' | 'dor' }
  | { type: 'selectionChange'; id: string | null; kind: WallSelectionKind }
  // Fires once per pane that becomes visible on the Wall — the initial seed ids,
  // splits, dor surfaces, restores, and auto-spawn — on both engines (dockview:
  // `onDidAddPanel`; Lath: the store-subscription leaf-id diff). Engine-neutral so
  // embedders (the website tutorial) can react to new panes without touching the
  // tiling api.
  | { type: 'paneAdded'; id: string }
  | { type: 'kill'; id: string }
  | { type: 'move'; fromId: string; toId: string };

export type SpawnDirection = 'left' | 'top' | 'top-left';
