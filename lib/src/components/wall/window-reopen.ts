import { freshSurfaceIdCount, withFreshSurfaceIds } from '../../lib/session-remap';
import { PERSISTED_WINDOW_VERSION, workspaceRecord, type PersistedWindow, type PersistedWorkspace, type WorkspaceId } from '../../lib/session-types';
import { surfaceIdMinter } from '../../lib/surface-ids';
import { getWorkspacesSnapshot, workspaceIdMinter } from '../../lib/workspace-store';
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
 * close is not reopenable. It keeps this Window's ids, marked `reopened`: the
 * window that boots from it remaps them ({@link withFreshWindowIds}), so the
 * close waits on no reservation for a Reopen that may never come.
 */
export function windowReopenSnapshot(): PersistedWindow | null {
  if (windowNeedsCloseConfirmation()) return null;
  const { workspaces, activeId } = getWorkspacesSnapshot();
  const records: PersistedWorkspace[] = [];
  for (const workspace of workspaces) {
    const handle = getWallHandle(workspace.id);
    // A Wall still mounting cannot say what it holds.
    if (!handle) return null;
    records.push(workspaceRecord(workspace, handle.serializeReported()));
  }
  if (records.length === 0) return null;
  return { version: PERSISTED_WINDOW_VERSION, workspaces: records, activeWorkspaceId: activeId, reopened: true };
}

/**
 * A reopened window's snapshot with every Workspace and Surface given a fresh
 * id, as a reopened Workspace's are (`docs/specs/reopen.md`), so nothing in the
 * new window shares one with what the close killed. Mints off the pools this
 * window installed at boot, reserving the whole count first: more ids than the
 * pools hold.
 */
export async function withFreshWindowIds(saved: PersistedWindow): Promise<PersistedWindow> {
  const [mintWorkspace, mintSurface] = await Promise.all([
    workspaceIdMinter(saved.workspaces.length),
    surfaceIdMinter(saved.workspaces.reduce((sum, { session }) => sum + freshSurfaceIdCount(session), 0)),
  ]);
  const fresh = new Map<WorkspaceId, WorkspaceId>();
  const workspaces = saved.workspaces.map((workspace) => {
    const id = mintWorkspace();
    fresh.set(workspace.id, id);
    return workspaceRecord({ ...workspace, id }, withFreshSurfaceIds(workspace.session, mintSurface));
  });
  return { version: PERSISTED_WINDOW_VERSION, workspaces, activeWorkspaceId: fresh.get(saved.activeWorkspaceId) ?? workspaces[0].id };
}
