import type { SurfaceKind } from 'dor/commands/types';
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
  /** The Surface's kind, so the Baseboard gates its label on the capability it
   *  needs (`hasTerminal`) rather than on the presence of a browser glyph. */
  kind: SurfaceKind;
  /** Browser-only presentation identity. Terminals omit it. */
  browserDisplay?: BrowserDisplayMode;
};

/** The visible-pane projection (`lath.listPanes()`). Shared by the Wall helpers,
 *  dev-server correlation, and session persistence. */
export type VisiblePane = { id: string; title: string | undefined; params: Record<string, unknown> | undefined };

export type WallMode = 'command' | 'passthrough';

export type WallSelectionKind = 'pane' | 'door';

/** How a Surface closure answers the archive: `prompt` raises the Keep open /
 *  Close anyway prompt on refusal, `silent` only returns the refusal, `discard`
 *  drops the notes instead of archiving them (docs/specs/notepad.md → "Closure"). */
export type CloseSurfaceMode = 'prompt' | 'silent' | 'discard';

export type DoorAfterRestoreAction =
  | 'confirm-kill'
  | 'close'
  | {
      type: 'replace-terminal';
      newId: string;
      shellName: string;
      announce: boolean;
    };

/**
 * The Window's Workspace verbs as a Wall's keyboard sees them. `WorkspaceWindow`
 * builds the single instance; targets resolve through the active Workspace, so a
 * hidden Wall's stale keystroke could not act on the wrong one. Absent on a bare
 * Wall, which leaves the Workspace keys unbound (docs/specs/shortcuts.md →
 * "Workspaces (command mode)").
 */
export interface WorkspaceCommands {
  create(): void;
  /** `+1` next, `-1` previous; wraps at both ends. */
  cycle(delta: 1 | -1): void;
  /** Activate the nth Workspace (0-based); out of range does nothing. */
  selectIndex(index: number): void;
  /** Ask the strip to run its close flow for the active Workspace. */
  requestClose(): void;
  /** Ask the strip to open its rename editor on the active Workspace. */
  requestRename(): void;
}

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
