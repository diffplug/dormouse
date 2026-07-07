import type { PersistedDoor } from '../../lib/session-types';

/** A minimized surface's baseboard chip. Identical to its persisted form; new doors
 *  carry a Lath restore `token`, pre-Lath doors carry the legacy `{neighborId,
 *  direction, ...}` fields (read-only for migration). */
export type DooredItem = PersistedDoor;

/** The visible-pane projection (`lath.listPanes()`). Shared by the Wall helpers,
 *  dev-server correlation, and session persistence. */
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
  // splits, dor surfaces, restores, and auto-spawn (the store-subscription leaf-id
  // diff). Lets embedders (the website tutorial) react to new panes without touching
  // the tiling engine.
  | { type: 'paneAdded'; id: string }
  | { type: 'kill'; id: string }
  | { type: 'move'; fromId: string; toId: string };
