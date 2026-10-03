import type { LeafMeta } from '../../lib/lath/persistence';
import type { PersistedSession } from '../../lib/session-types';
import type { SurfaceReopenRecord } from '../../lib/reopen-stack';
import type { BrowserAutomationProvider } from 'dor-lib-common/browser-providers';
import type { WorkspaceId } from '../../lib/session-types';
import type { SaveOptions } from '../../lib/session-save';
import type { PreparedWorkspaceTransfer } from './workspace-transfer';
import type { DorControlRequest } from './use-dor-control';

export interface PreparedSurfaceMove {
  meta: LeafMeta;
  surfaceRef: string;
  iframe: boolean;
  terminal: boolean;
  /** Detach membership, never the Session. Returns a complete Wall rollback. */
  depart(): () => void;
}

/**
 * The imperative surface a mounted `<Wall>` exposes to code outside its React
 * tree: the strip, the window-level persistence owner, and the `dor` router
 * (`docs/specs/layout.md` → "Workspaces"). Every Wall registers one, a bare Wall
 * under `DEFAULT_WORKSPACE_ID`, so exactly one handle answers a `dor` request
 * even in the single-Workspace hosts.
 */
export interface WallHandle {
  canMoveSurfaces: boolean;
  prepareSurfaceMove(id: string): PreparedSurfaceMove;
  adoptSurfaceMove(id: string, meta: LeafMeta): { surfaceRef: string; rollback(): void };
  finishSurfaceMove(): void;
  focusSurface(id: string, acknowledge: boolean): void;
  showMoveNotice(id: string, text: string): void;
  /** A brief notice on the pane the user is on: the Window's answer to a verb
   *  with nothing to act on. */
  showNotice(text: string): void;
  /** Rebuild a closed Surface here (`docs/specs/reopen.md`); `focus` selects it. */
  reopenSurface(record: SurfaceReopenRecord, focus: boolean): { id: string; ref: string };
  /** This Workspace's record now, with no cwd probe. */
  serializeNow(): PersistedSession;
  /** The same, each cwd as its Session last reported it: a reopen record. */
  serializeReported(): PersistedSession;
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
  /** Any member a user close would confirm (`closeKind` in
   *  `lib/src/components/wall/close-kind.ts`): the Workspace close gate. */
  needsCloseConfirmation(): boolean;
  /** Dirty reports consumed only by Tool-designated members, including Doors. */
  dirtyToolIds(): string[];
  /** Leave command selection on chrome and focus a live pane. */
  enterSelectedPane(): void;
  enterCommandMode(): void;
  selectWorkspaceTab(): void;
  /** Enter `nextTodoMember` after the current selection as a click on it
   *  would — passthrough on a pane, a Door reattached into passthrough, both
   *  acknowledging without input — answering the member it entered. Null,
   *  changing nothing, when no member has a TODO. Never clears a TODO
   *  (`docs/specs/layout.md` → "Workspace tabs"). */
  enterNextTodo(): string | null;
  /** The label, as its Door and pane header show it, of the member
   *  `enterNextTodo` would enter now, for the tab pill's tooltip. Reads only. */
  peekNextTodo(): string | null;
  /** Persist now. `probeCwd: false` skips the cwd re-read (`SessionFlushRequest`). */
  flushPersistence(options?: SaveOptions): Promise<void>;
  /** Build what another Window needs to take this Workspace, without touching
   *  it. The caller commits only once the host has accepted, which is what keeps
   *  a refused transfer from gutting the Workspace. An explicit verb, never an
   *  unmount effect (`releaseSession` in `lib/src/lib/terminal-lifecycle.ts`). */
  prepareWorkspaceTransfer(): Promise<PreparedWorkspaceTransfer>;
  /** Close every member Surface through the closure coordinator. Resolves null
   *  once the Wall is empty, else the first refusal's message with the Workspace
   *  left as it was. `editors` are the dirty Tools whose close was consented. */
  closeAll(editors?: readonly string[]): Promise<string | null>;
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
    canMoveSurfaces: false,
    prepareSurfaceMove: () => { throw new Error('Surface moves are unavailable'); },
    adoptSurfaceMove: () => { throw new Error('Surface moves are unavailable'); },
    finishSurfaceMove: () => {},
    focusSurface: () => {},
    showMoveNotice: () => {},
    showNotice: () => {},
    reopenSurface: () => { throw new Error('Reopen is unavailable'); },
    serializeNow: () => ({ version: 3, panes: [] }),
    serializeReported: () => ({ version: 3, panes: [] }),
    surfaceIds: () => [],
    ownsSurface: () => false,
    iframeSurfaceRefs: () => [],
    browserSessions: () => [],
    needsCloseConfirmation: () => false,
    dirtyToolIds: () => [],
    enterSelectedPane: () => {},
    enterCommandMode: () => {},
    selectWorkspaceTab: () => {},
    enterNextTodo: () => null,
    peekNextTodo: () => null,
    flushPersistence: async () => {},
    prepareWorkspaceTransfer: async () => ({
      payload: {
        workspaceId,
        workspace: { id: workspaceId, name: '', nameIsAuto: false, session: { version: 3, panes: [] } },
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
