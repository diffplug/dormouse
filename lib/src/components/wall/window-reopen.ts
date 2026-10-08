import { freshSurfaceIdCount, withFreshSurfaceIds } from '../../lib/session-remap';
import { PERSISTED_WINDOW_VERSION, workspaceRecord, type PersistedSession, type PersistedWindow, type WorkspaceId } from '../../lib/session-types';
import { surfaceIdMinter } from '../../lib/surface-ids';
import { getWorkspacesSnapshot, workspaceIdMinter, type WorkspaceMeta } from '../../lib/workspace-store';
import { getWallHandle } from './wall-handles';
import { pendingKillSessionIds } from '../../lib/pending-kills';
import { countRunningSessionsIn } from '../../lib/terminal-state-store';

/**
 * Closing one window of several (`docs/specs/reopen.md` → "Workspaces and
 * windows"): its members follow the same table as a Surface close, and a close
 * that asks nothing leaves the host a record to reopen it from.
 */

/** Whether closing this Window asks first: any Workspace's close would, a
 *  Workspace's Wall has not mounted to say what it holds, or a pending kill
 *  holds running work (`docs/specs/reopen.md`). */
export function windowNeedsCloseConfirmation(): boolean {
  return getWorkspacesSnapshot().workspaces.some(workspace => getWallHandle(workspace.id)?.needsCloseConfirmation() ?? true)
    || countRunningSessionsIn(pendingKillSessionIds()) > 0;
}


/**
 * This Window as the snapshot a reopened window boots from, or null when its
 * close is not reopenable. Every Workspace and Surface takes a fresh id, as a
 * reopened Workspace does, so nothing in the new window shares one with what
 * the close kills.
 */
export async function windowReopenSnapshot(): Promise<PersistedWindow | null> {
  if (windowNeedsCloseConfirmation()) return null;
  // Read before the reservation awaits, as the window stands at its close.
  const { workspaces, activeId } = getWorkspacesSnapshot();
  const closing: { workspace: WorkspaceMeta; session: PersistedSession }[] = [];
  for (const workspace of workspaces) {
    const handle = getWallHandle(workspace.id);
    // A Wall still mounting cannot say what it holds.
    if (!handle) return null;
    closing.push({ workspace, session: handle.serializeReported() });
  }
  if (closing.length === 0) return null;
  // The whole window remaps at once, more ids than the pools hold.
  const [mintWorkspace, mintSurface] = await Promise.all([
    workspaceIdMinter(closing.length),
    surfaceIdMinter(closing.reduce((sum, { session }) => sum + freshSurfaceIdCount(session), 0)),
  ]);
  const fresh = new Map<WorkspaceId, WorkspaceId>();
  const records = closing.map(({ workspace, session }) => {
    const id = mintWorkspace();
    fresh.set(workspace.id, id);
    return workspaceRecord({ ...workspace, id }, withFreshSurfaceIds(session, mintSurface));
  });
  return { version: PERSISTED_WINDOW_VERSION, workspaces: records, activeWorkspaceId: fresh.get(activeId) ?? records[0].id };
}
