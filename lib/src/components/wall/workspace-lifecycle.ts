import { randomKillChar } from '../KillConfirm';
import { getWallHandle } from './wall-handles';
import { forgetWorkspaceSession } from '../../lib/window-session-aggregator';
import { setPendingWorkspaceClose, setRenamingWorkspace } from '../../lib/workspace-ui-store';
import { closeWorkspace, getWorkspacesSnapshot, setActiveWorkspace } from '../../lib/workspace-store';
import type { WorkspaceId } from '../../lib/session-types';

/**
 * The Workspace close and rename verbs, outside any component: the strip's
 * buttons, the command-mode keys, and (later) `dor workspace` all take the same
 * route (`docs/specs/layout.md` → "Workspaces"). The strip renders the
 * confirmation these open; it decides nothing.
 */

/** Whether closing this Workspace asks first: it holds a Surface the user has
 *  typed into, or a running Session. */
export function workspaceNeedsCloseConfirmation(id: WorkspaceId): boolean {
  const handle = getWallHandle(id);
  return !!handle && (handle.hasTouchedSurfaces() || handle.runningCount() > 0);
}

/**
 * Close every member Surface through the closure coordinator, then drop the
 * Workspace itself. Resolves the first refusal's message with the Workspace left
 * as it was — revealed, so the prompt behind the refusal is on screen — or null
 * once it is gone. Membership is cleared by the Wall's own unmount.
 */
export async function closeWorkspaceWithSurfaces(id: WorkspaceId): Promise<string | null> {
  const handle = getWallHandle(id);
  if (handle) {
    const refusal = await handle.closeAll('prompt');
    if (refusal) {
      setActiveWorkspace(id);
      return refusal;
    }
  }
  forgetWorkspaceSession(id);
  closeWorkspace(id);
  return null;
}

/**
 * Begin closing a Workspace: the last one never closes (there is always one
 * active Workspace), one holding work raises the typed confirmation, and any
 * other goes immediately.
 */
export function requestWorkspaceClose(id: WorkspaceId): void {
  if (getWorkspacesSnapshot().workspaces.length <= 1) return;
  if (workspaceNeedsCloseConfirmation(id)) {
    setPendingWorkspaceClose({ id, char: randomKillChar() });
    return;
  }
  void closeWorkspaceWithSurfaces(id);
}

/** Open the strip's inline rename editor on a Workspace. */
export function requestWorkspaceRename(id: WorkspaceId): void {
  setRenamingWorkspace(id);
}
