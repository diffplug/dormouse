import type { BrowserAutomationProvider } from 'dor-lib-common/browser-providers';
import type { WorkspaceId } from '../../lib/session-types';
import type { SaveOptions } from '../../lib/session-save';
import type { PreparedWorkspaceTransfer } from './workspace-transfer';
import type { CloseSurfaceMode } from './wall-types';
import type { DorControlRequest } from './use-dor-control';

/**
 * The imperative surface a mounted `<Wall>` exposes to code outside its React
 * tree: the strip, the window-level persistence owner, and the `dor` router
 * (`docs/specs/layout.md` → "Workspaces"). Every Wall registers one, a bare Wall
 * under `DEFAULT_WORKSPACE_ID`, so exactly one handle answers a `dor` request
 * even in the single-Workspace hosts.
 */
export interface WallHandle {
  workspaceId: WorkspaceId;
  /** The Wall's member Surfaces: visible panes ∪ Doors. */
  surfaceIds(): string[];
  ownsSurface(id: string): boolean;
  /** Member Surfaces rendered as plain iframes, Doored ones included, as their
   *  Workspace-stable `surface:N` refs: the page state a move between Windows
   *  destroys (`docs/specs/layout.md` → Workspaces). Refs, not internal ids,
   *  because the refusal naming them is read by a `dor` caller. Agent-browser
   *  Surfaces are not among them — their session lives in the host and
   *  reconnects. */
  iframeSurfaceRefs(): string[];
  /** The sessions of `provider` that member browser Surfaces are bound to or
   *  launching, which a `--key` elsewhere in the Window must not mint again
   *  (docs/specs/dor-browser.md → "Managed identity"). */
  browserSessions(provider: BrowserAutomationProvider): string[];
  /** Any member terminal Session the user has typed into (the close confirmation
   *  gate, alongside `runningCount`). */
  hasTouchedSurfaces(): boolean;
  runningCount(): number;
  /** Leave command selection on chrome and focus a live pane. */
  enterSelectedPane(): void;
  enterCommandMode(): void;
  selectWorkspaceTab(): void;
  /** Command mode on `nextTodoMember` after the current selection — a pane
   *  selected, a Door selected and never reattached — answering the member it
   *  selected. Null, changing nothing, when no member has a TODO. Selection
   *  only: never an alert verb (`docs/specs/layout.md` → "Workspace tabs"). */
  selectNextTodo(): string | null;
  /** The member `selectNextTodo` would select now, with the label its Door and
   *  pane header show, for the tab pill's tooltip. Reads only. */
  peekNextTodo(): { id: string; label: string } | null;
  /** Persist now. `probeCwd: false` skips the cwd re-read (`SessionFlushRequest`). */
  flushPersistence(options?: SaveOptions): Promise<void>;
  /** Build what another Window needs to take this Workspace, without touching
   *  it. The caller commits only once the host has accepted, which is what keeps
   *  a refused transfer from gutting the Workspace. An explicit verb, never an
   *  unmount effect (`releaseSession` in `lib/src/lib/terminal-lifecycle.ts`). */
  prepareWorkspaceTransfer(): Promise<PreparedWorkspaceTransfer>;
  /** Close every member Surface through the closure coordinator. Resolves null
   *  once the Wall is empty, else the first refusal's message with the Workspace
   *  left as it was. */
  closeAll(mode?: CloseSurfaceMode): Promise<string | null>;
  handleDorControl(detail: DorControlRequest): void;
}

const handles = new Map<WorkspaceId, WallHandle>();

/**
 * Register a Wall's handle, replacing any entry under the same Workspace id. The
 * returned disposer removes the entry only while it is still this handle, so
 * StrictMode's mount/unmount/mount cannot deregister the live Wall.
 */
export function registerWallHandle(handle: WallHandle): () => void {
  handles.set(handle.workspaceId, handle);
  return () => {
    if (handles.get(handle.workspaceId) === handle) handles.delete(handle.workspaceId);
  };
}

export function getWallHandle(workspaceId: WorkspaceId): WallHandle | null {
  return handles.get(workspaceId) ?? null;
}

/** Every registered handle, in registration order. */
export function listWallHandles(): WallHandle[] {
  return [...handles.values()];
}

/** The handle whose Wall owns `surfaceId`, or null. A Wall answers false for a
 *  foreign id, so the first true answer is the owner. */
export function wallHandleOwning(surfaceId: string): WallHandle | null {
  for (const handle of handles.values()) {
    if (handle.ownsSurface(surfaceId)) return handle;
  }
  return null;
}

/** Forget every handle (tests). */
export function resetWallHandles(): void {
  handles.clear();
}

/** An inert handle for a Wall that is not mounted (tests and Storybook), so a new
 *  `WallHandle` member is one edit here rather than one per fixture. Lives beside
 *  the interface, and not in a test util, because a story needs it too and must
 *  not pull vitest into the Storybook bundle. */
export function stubWallHandle(workspaceId: WorkspaceId, overrides: Partial<WallHandle> = {}): WallHandle {
  return {
    workspaceId,
    surfaceIds: () => [],
    ownsSurface: () => false,
    iframeSurfaceRefs: () => [],
    browserSessions: () => [],
    hasTouchedSurfaces: () => false,
    runningCount: () => 0,
    enterSelectedPane: () => {},
    enterCommandMode: () => {},
    selectWorkspaceTab: () => {},
    selectNextTodo: () => null,
    peekNextTodo: () => null,
    flushPersistence: async () => {},
    prepareWorkspaceTransfer: async () => ({
      payload: {
        workspaceId,
        workspace: { id: workspaceId, name: '', nameIsAuto: false, session: { version: 3, panes: [] } },
        notepad: { surfaces: [], stagedDeletions: {} },
        terminalIds: [],
        allIds: [],
      },
      commit: () => {},
    }),
    closeAll: async () => null,
    handleDorControl: () => {},
    ...overrides,
  };
}
