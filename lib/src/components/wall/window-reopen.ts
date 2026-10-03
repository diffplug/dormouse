import { withFreshSurfaceIds } from '../../lib/session-remap';
import type { PersistedWindow, PersistedWorkspace, WorkspaceId } from '../../lib/session-types';
import { generateWorkspaceId, getWorkspacesSnapshot } from '../../lib/workspace-store';
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
export function windowReopenSnapshot(): PersistedWindow | null {
  if (windowNeedsCloseConfirmation()) return null;
  const { workspaces, activeId } = getWorkspacesSnapshot();
  const fresh = new Map<WorkspaceId, WorkspaceId>();
  const records: PersistedWorkspace[] = [];
  for (const workspace of workspaces) {
    const handle = getWallHandle(workspace.id);
    // A Wall still mounting cannot say what it holds.
    if (!handle) return null;
    const id = generateWorkspaceId();
    fresh.set(workspace.id, id);
    records.push({ id, name: workspace.name, nameIsAuto: workspace.nameIsAuto, session: withFreshSurfaceIds(handle.serializeReported()) });
  }
  if (records.length === 0) return null;
  return { version: 1, workspaces: records, activeWorkspaceId: fresh.get(activeId) ?? records[0].id };
}
