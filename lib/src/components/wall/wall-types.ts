import type { BrowserDisplayMode } from './agent-browser-screen';

/** A minimized Surface's baseboard chip, at RUNTIME: an identity plus the Lath
 *  restore `token` that says where it goes back. Deliberately carries no
 *  title/params/component — the store owns a Doored Surface's metadata, which keeps
 *  changing while it is minimized, so a copy here could only go stale
 *  (docs/specs/layout.md → "Minimize and reattach"). `PersistedDoor` is the wire
 *  form, materialized from the store at save time. */
export type DooredItem = { id: string; token?: unknown };

/** A Door as the Baseboard draws it: the runtime record plus the engine-tracked
 *  fallback title, projected fresh from the store on each render rather than stored.
 *  Structurally a `DooredItem`, so it passes straight back to the reattach/drag
 *  callbacks. */
export type DoorChip = DooredItem & {
  title: string;
  /** Browser-only capability/presentation identity. Terminals omit it. */
  browserDisplay?: BrowserDisplayMode;
};

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
