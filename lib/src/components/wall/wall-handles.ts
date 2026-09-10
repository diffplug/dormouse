import type { WorkspaceId } from '../../lib/session-types';
import type { SaveOptions } from '../../lib/session-save';
import type { WorkspaceTransferPayload } from './workspace-transfer';
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
  /** Any member terminal Session the user has typed into (the close confirmation
   *  gate, alongside `runningCount`). */
  hasTouchedSurfaces(): boolean;
  runningCount(): number;
  /** Persist now. `probeCwd: false` skips the cwd re-read (`SessionFlushRequest`). */
  flushPersistence(options?: SaveOptions): Promise<void>;
  /** Hand this Workspace to another Window: build its record, take its notes,
   *  and detach every Session **without killing one**. An explicit verb, never
   *  an unmount effect (`releaseSession` in
   *  `lib/src/lib/terminal-lifecycle.ts`). */
  releaseWorkspaceForTransfer(): Promise<WorkspaceTransferPayload>;
  /** Close every member Surface through the closure coordinator. Resolves null
   *  once the Wall is empty, else the first refusal's message with the Workspace
   *  left as it was. */
  closeAll(mode?: CloseSurfaceMode): Promise<string | null>;
  /** Abandon a close the Wall has already emptied for: the Workspace survives,
   *  so its "always one pane" rule is re-armed and the tree refilled. The close
   *  verb calls it when the store refuses to drop the Workspace after all. */
  cancelClose(): void;
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
    hasTouchedSurfaces: () => false,
    runningCount: () => 0,
    flushPersistence: async () => {},
    releaseWorkspaceForTransfer: async () => ({
      workspaceId,
      workspace: { id: workspaceId, name: '', session: { version: 3, panes: [] } },
      notepad: { surfaces: [], stagedDeletions: {} },
      terminalIds: [],
      allIds: [],
    }),
    closeAll: async () => null,
    cancelClose: () => {},
    handleDorControl: () => {},
    ...overrides,
  };
}
