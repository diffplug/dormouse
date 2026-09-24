import { randomKillChar } from '../KillConfirm';
import { flushSync } from 'react-dom';
import { awaitWallHandle, mountingRefusal } from './dor-control-shared';
import { getWallHandle } from './wall-handles';
import { forgetWorkspaceSession, isWorkspaceTransferPending } from '../../lib/window-session-aggregator';
import { dismissWorkspaceUi, setPendingWorkspaceClose, setRenamingWorkspace } from '../../lib/workspace-ui-store';
import { closeWorkspace, getActiveWorkspaceId, setActiveWorkspace, workspaceRefFor } from '../../lib/workspace-store';
import type { WorkspaceId } from '../../lib/session-types';
import type { CloseSurfaceMode } from './wall-types';

/**
 * The Workspace close and rename verbs, outside any component: the strip's
 * buttons and `dor workspace` take the same route
 * (`docs/specs/layout.md` → "Workspaces"). The strip renders the confirmation
 * these open; it decides nothing.
 */

/** Whether closing this Workspace asks first: it holds a Surface the user has
 *  typed into, or a running Session. */
export function workspaceNeedsCloseConfirmation(id: WorkspaceId): boolean {
  const handle = getWallHandle(id);
  return !!handle && (handle.hasTouchedSurfaces() || handle.runningCount() > 0);
}

/** A click on `+` waits for the fresh Wall before focusing its terminal. */
export async function enterWorkspace(id: WorkspaceId): Promise<void> {
  setActiveWorkspace(id);
  const handle = await awaitWallHandle(id);
  if (getActiveWorkspaceId() === id) handle?.enterSelectedPane();
}

const CLOSE_IN_FLIGHT_REFUSAL = 'another Workspace is closing';

/** Serialize closure and successor selection across the Window. */
let closeInFlight = false;

/**
 * Close every member Surface through the closure coordinator, then drop the
 * Workspace itself. Resolves the first refusal's message with the Workspace left
 * as it was, or null once it is gone. Membership is cleared by the Wall's own
 * unmount.
 *
 * `mode` is the closure mode each member Surface is closed with: `prompt` for a
 * user gesture, `silent` for `dor workspace close`, whose caller is a command
 * rather than someone looking at the Wall (`docs/specs/notepad.md` → "Closure").
 * **A refusal reveals the Workspace only in `prompt` mode** — there is a prompt
 * behind it to show; a silent caller gets the message and the user is left where
 * they were.
 *
 * **A Workspace whose Wall is not registered is refused**, never closed: the
 * Wall is what walks the member Surfaces, so dropping the Workspace without one
 * would leave its Sessions running with nothing holding them
 * (`docs/specs/glossary.md` → "Invariants" I4).
 */
export async function closeWorkspaceWithSurfaces(
  id: WorkspaceId,
  mode: CloseSurfaceMode = 'prompt',
): Promise<string | null> {
  if (isWorkspaceTransferPending(id)) return 'Workspace is transferring';
  if (closeInFlight) return CLOSE_IN_FLIGHT_REFUSAL;
  const handle = getWallHandle(id);
  if (!handle) return mountingRefusal(workspaceRefFor(id));
  closeInFlight = true;
  try {
    if (mode === 'prompt') {
      // Commit visibility before collapse measures the Wall, even for an
      // untouched Workspace whose close skips the confirmation.
      flushSync(() => { setActiveWorkspace(id); handle.selectWorkspaceTab(); });
    }
    const refusal = await handle.closeAll(mode);
    if (refusal) {
      // A refusal returns to its prompt if the user navigated away during close.
      if (mode === 'prompt') setActiveWorkspace(id);
      return refusal;
    }
    let closed = false;
    // Mount a replacement Wall before selecting its tab, including the last close.
    flushSync(() => { closed = closeWorkspace(id); });
    if (!closed) return 'Workspace no longer exists';
    forgetWorkspaceSession(id);
    // Clear only this Workspace's chrome: a stranded editor or confirmation
    // holds the keyboard lease after its Workspace disappears.
    dismissWorkspaceUi(id);
    if (mode === 'prompt') getWallHandle(getActiveWorkspaceId())?.selectWorkspaceTab();
    return null;
  } finally {
    closeInFlight = false;
  }
}

/**
 * Begin closing a Workspace. Reveal it first; work raises the typed
 * confirmation, otherwise close immediately.
 */
export function requestWorkspaceClose(id: WorkspaceId): void {
  if (closeInFlight || isWorkspaceTransferPending(id)) return;
  void closeOnceWallRegisters(id);
}

/**
 * The Wall is what says whether the Workspace holds work, so a gesture landing
 * in the registration gap — the strip's `×` right after a create — waits it
 * out, as `dor workspace close` does, rather than deciding on a handle that is
 * one effect away and having the close refused where nobody reads the refusal
 * (`docs/specs/layout.md` → "Workspaces").
 */
async function closeOnceWallRegisters(id: WorkspaceId): Promise<void> {
  const handle = await awaitWallHandle(id);
  if (closeInFlight || isWorkspaceTransferPending(id)) return;
  if (!handle) return;
  if (workspaceNeedsCloseConfirmation(id)) {
    // An immediate close reveals the Workspace itself.
    setActiveWorkspace(id);
    handle.selectWorkspaceTab();
    setPendingWorkspaceClose({ id, char: randomKillChar() });
    return;
  }
  await closeWorkspaceWithSurfaces(id);
}

/** Open the strip's inline rename editor on a Workspace. */
export function requestWorkspaceRename(id: WorkspaceId): void {
  setRenamingWorkspace(id);
}
