import { getWorkspacesSnapshot } from './workspace-store';
import type { PersistedSession, PersistedWindow, PersistedWorkspace, WorkspaceId } from './session-types';

/**
 * Collects each Workspace's latest `PersistedSession` into one `PersistedWindow`
 * (`docs/specs/transport.md` → "Persisted session"). The Wall's persistence hook
 * publishes here instead of writing the platform slot when it runs under a
 * Workspace; the writer that turns snapshots into a host write is installed
 * separately, and standalone installs none yet.
 */

const sessions = new Map<WorkspaceId, PersistedSession>();
let writer: ((snapshot: PersistedWindow) => void) | null = null;

/** Record a Workspace's latest session and hand the whole Window to the writer. */
export function publishWorkspaceSession(workspaceId: WorkspaceId, session: PersistedSession): void {
  sessions.set(workspaceId, session);
  writer?.(getWindowSnapshot());
}

/** Drop a Workspace's session (its Workspace was closed or moved away). */
export function forgetWorkspaceSession(workspaceId: WorkspaceId): void {
  if (!sessions.delete(workspaceId)) return;
  writer?.(getWindowSnapshot());
}

/**
 * The Window as it stands: Workspaces in strip order carrying the id, name, and
 * latest published session of each. A Workspace whose Wall has published nothing
 * yet is omitted rather than written empty, so a crash mid-boot cannot replace a
 * restored layout with a blank one.
 */
export function getWindowSnapshot(): PersistedWindow {
  const { workspaces, activeId } = getWorkspacesSnapshot();
  const collected: PersistedWorkspace[] = [];
  for (const workspace of workspaces) {
    const session = sessions.get(workspace.id);
    if (!session) continue;
    collected.push({ id: workspace.id, name: workspace.name, session });
  }
  return { version: 1, workspaces: collected, activeWorkspaceId: activeId };
}

/** Install the sink that persists a Window snapshot; returns its uninstaller.
 *  Replace-on-repeat: only one writer is live, so a re-install cannot double-write. */
export function installWindowSessionWriter(write: (snapshot: PersistedWindow) => void): () => void {
  writer = write;
  return () => {
    if (writer === write) writer = null;
  };
}

/** Forget every published session and any installed writer (tests). */
export function resetWindowSessionAggregator(): void {
  sessions.clear();
  writer = null;
}
