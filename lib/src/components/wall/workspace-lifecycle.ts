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

/** The two ways a close is turned down before it starts. Both leave every
 *  Surface where it was. */
export const LAST_WORKSPACE_REFUSAL = 'the last Workspace cannot be closed';
const CLOSE_IN_FLIGHT_REFUSAL = 'another Workspace is closing';

/** One close at a time, for the whole Window. Two closes overlapping would each
 *  see the other's Workspace in the count, empty both Walls, and leave the
 *  Window with a single Workspace whose Surfaces are all gone. */
let closeInFlight = false;

/**
 * Close every member Surface through the closure coordinator, then drop the
 * Workspace itself. Resolves the first refusal's message with the Workspace left
 * as it was — revealed, so the prompt behind the refusal is on screen — or null
 * once it is gone. Membership is cleared by the Wall's own unmount.
 */
export async function closeWorkspaceWithSurfaces(id: WorkspaceId): Promise<string | null> {
  if (closeInFlight) return CLOSE_IN_FLIGHT_REFUSAL;
  // Re-checked here, not only in `requestWorkspaceClose`: the count can drop
  // while the typed confirmation is on screen, and emptying the Wall for a
  // `closeWorkspace` the store then refuses would leave the Window's one
  // Workspace with nothing in it.
  if (getWorkspacesSnapshot().workspaces.length <= 1) return LAST_WORKSPACE_REFUSAL;
  closeInFlight = true;
  const handle = getWallHandle(id);
  try {
    if (handle) {
      const refusal = await handle.closeAll('prompt');
      if (refusal) {
        setActiveWorkspace(id);
        return refusal;
      }
    }
    if (!closeWorkspace(id)) {
      // The Wall is empty and stays mounted, so hand it back its auto-spawn.
      handle?.cancelClose();
      setActiveWorkspace(id);
      return LAST_WORKSPACE_REFUSAL;
    }
    forgetWorkspaceSession(id);
    return null;
  } finally {
    closeInFlight = false;
  }
}

/**
 * Begin closing a Workspace: the last one never closes (there is always one
 * active Workspace), one holding work raises the typed confirmation, and any
 * other goes immediately.
 */
export function requestWorkspaceClose(id: WorkspaceId): void {
  if (closeInFlight) return;
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
