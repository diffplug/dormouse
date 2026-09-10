import type { PersistedSession, WorkspaceId } from '../../lib/session-types';
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
  serialize(): Promise<PersistedSession>;
  flushPersistence(): Promise<void>;
  /** Put DOM focus back on this Wall's selected Surface, honoring its own mode. */
  focusSelected(): void;
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
