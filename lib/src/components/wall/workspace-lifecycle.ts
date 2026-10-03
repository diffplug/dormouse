import { randomKillChar } from '../KillConfirm';
import { flushSync } from 'react-dom';
import { awaitWallHandle, mountingRefusal } from './dor-control-shared';
import { getWallHandle } from './wall-handles';
import { forgetWorkspaceSession, isWorkspaceTransferPending } from '../../lib/window-session-aggregator';
import { cancelPendingConfirmation, dismissWorkspaceUi, requestConfirmation, setRenamingWorkspace, type WorkspaceConfirmation } from '../../lib/workspace-ui-store';
import { closeWorkspace, createWorkspace, getActiveWorkspaceId, getWorkspacesSnapshot, moveWorkspace, setActiveWorkspace, workspaceRefFor } from '../../lib/workspace-store';
import { addPendingKill } from '../../lib/pending-kills';
import { isDelayedKillEnabled } from '../../lib/labs-settings';
import type { PersistedSession, WorkspaceId } from '../../lib/session-types';
import { pushReopenRecord, type WorkspaceReopenRecord } from '../../lib/reopen-stack';
import type { WorkspaceCloseMode } from './wall-types';
import { confirmToolEditorsClose, UNSAVED_TOOL_REFUSAL } from '../../lib/tool-editor';

/**
 * The Workspace close and rename verbs, outside any component: the strip's
 * buttons and `dor workspace` take the same route
 * (`docs/specs/layout.md` → "Workspaces"). The strip renders the confirmation
 * these open; it decides nothing.
 */

/** Whether closing this Workspace asks first: any member is one whose own
 *  close would ask (`docs/specs/layout.md` → "Workspace lifecycle"). */
export function workspaceNeedsCloseConfirmation(id: WorkspaceId): boolean {
  return getWallHandle(id)?.needsCloseConfirmation() ?? false;
}

/** A click on `+` waits for the fresh Wall before focusing its terminal. */
export async function enterWorkspace(id: WorkspaceId): Promise<void> {
  setActiveWorkspace(id);
  const handle = await awaitWallHandle(id);
  if (getActiveWorkspaceId() === id) handle?.enterSelectedPane();
}

/**
 * Keyboard Enter on an inactive tab: activate it in command mode with the ring
 * still on its tab, as a click leaves the user in command mode. Activation never
 * waits on the Wall, as a click does not; selecting in the same tick keeps the
 * ring from gliding to the Wall's pane first.
 */
export async function activateWorkspaceTab(id: WorkspaceId): Promise<void> {
  const handle = getWallHandle(id);
  handle?.selectWorkspaceTab();
  setActiveWorkspace(id);
  if (handle) return;
  // A Wall still registering selects its tab once it does, unless the user
  // has moved to another Workspace in the meantime.
  const late = await awaitWallHandle(id);
  if (getActiveWorkspaceId() === id) late?.selectWorkspaceTab();
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
 * `mode` is `prompt` for a user gesture, `silent` for `dor workspace close`.
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
  mode: WorkspaceCloseMode = 'prompt',
): Promise<string | null> {
  const isCurrent = cancelPendingConfirmation();
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
    // One question for every dirty Tool, before any Surface closes; a command
    // close refuses instead (`docs/specs/dor-tool.md` → Closing unsaved Tools).
    const editors = handle.dirtyToolIds();
    if (editors.length && (mode === 'silent' || !await confirmToolEditorsClose(editors))) return UNSAVED_TOOL_REFUSAL;
    if (!isCurrent()) return 'Workspace close was superseded by a newer close or move';
    // Reopenable only whole: one member whose own close would ask leaves no
    // record, so the record is taken before any member closes.
    const record = handle.needsCloseConfirmation() ? null : workspaceReopenRecord(id, handle.serializeReported());
    const refusal = await handle.closeAll(editors);
    if (refusal) {
      // A refusal returns to its prompt if the user navigated away during close.
      if (mode === 'prompt') setActiveWorkspace(id);
      return refusal;
    }
    let closed = false;
    // Mount a replacement Wall before selecting its tab, including the last close.
    flushSync(() => { closed = closeWorkspace(id); });
    if (!closed) return 'Workspace no longer exists';
    if (record) pushReopenRecord(record);
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
  const isCurrent = cancelPendingConfirmation();
  if (closeInFlight || isWorkspaceTransferPending(id)) return;
  void closeOnceWallRegisters(id, isCurrent);
}

/**
 * The Wall is what says whether the Workspace holds work, so a gesture landing
 * in the registration gap — the strip's `×` right after a create — waits it
 * out, as `dor workspace close` does, rather than deciding on a handle that is
 * one effect away and having the close refused where nobody reads the refusal
 * (`docs/specs/layout.md` → "Workspaces").
 */
async function closeOnceWallRegisters(id: WorkspaceId, isCurrent: () => boolean): Promise<void> {
  const handle = await awaitWallHandle(id);
  if (!isCurrent()) return;
  if (closeInFlight || isWorkspaceTransferPending(id)) return;
  if (!handle) return;
  if (workspaceNeedsCloseConfirmation(id)) {
    if (isDelayedKillEnabled()) { pendWorkspace(id); return; }
    // An immediate close reveals the Workspace itself.
    setActiveWorkspace(id);
    handle.selectWorkspaceTab();
    requestConfirmation(workspaceCloseConfirmation(id));
    return;
  }
  await closeWorkspaceWithSurfaces(id);
}

/**
 * Workspaces off the strip whose Walls must stay mounted: pending kills, and
 * ones finalizing until their Surfaces are disposed (`docs/specs/glossary.md`
 * → "Invariants" I4). `WorkspaceWindow` renders these beside the strip's.
 */
let held: readonly WorkspaceId[] = [];
const heldListeners = new Set<() => void>();

function setHeld(next: readonly WorkspaceId[]): void {
  held = next;
  for (const listener of heldListeners) listener();
}

export function getHeldWorkspaces(): readonly WorkspaceId[] {
  return held;
}

export function subscribeToHeldWorkspaces(listener: () => void): () => void {
  heldListeners.add(listener);
  return () => { heldListeners.delete(listener); };
}

/**
 * A Workspace close that would ask, under Labs: the tab leaves the strip at
 * once while its Wall stays mounted and inactive, until its countdown closes
 * it or the user restores it (`docs/specs/reopen.md` → "Labs: No-confirm
 * delayed kill").
 */
function pendWorkspace(id: WorkspaceId): void {
  const { workspaces } = getWorkspacesSnapshot();
  const index = workspaces.findIndex(workspace => workspace.id === id);
  if (index < 0) return;
  const meta = workspaces[index];
  dismissWorkspaceUi(id);
  setHeld([...held, id]);
  // Off the strip: the store selects a successor, or a fresh replacement.
  flushSync(() => { closeWorkspace(id); });
  // Nothing pending survives a restart.
  forgetWorkspaceSession(id);
  getWallHandle(getActiveWorkspaceId())?.selectWorkspaceTab();
  const release = () => setHeld(held.filter(heldId => heldId !== id));
  const restore = (focus: boolean) => {
    createWorkspace({ id, name: meta.name, nameIsAuto: meta.nameIsAuto, alertDelivery: meta.alertDelivery, activate: focus });
    moveWorkspace(id, index);
    release();
    // Back on the strip: its record is written again.
    void getWallHandle(id)?.flushPersistence();
    if (focus) getWallHandle(id)?.selectWorkspaceTab();
  };
  addPendingKill({ kind: 'workspace', id, workspaceId: id, title: meta.name, label: 'Workspace' }, {
    restore,
    finalize: () => {
      const handle = getWallHandle(id);
      if (!handle) { release(); return; }
      // Unsaved Tool edits are discarded: the pending kill was the decision.
      void handle.closeAll(handle.dirtyToolIds()).then(refusal => {
        // Work that refuses to close (a helper's) brings the Workspace back to say so.
        if (refusal) { restore(true); return; }
        release();
        dismissWorkspaceUi(id);
      });
    },
  });
}

/** The typed close question; the key is ignored while the Workspace transfers. */
export function workspaceCloseConfirmation(id: WorkspaceId, char = randomKillChar()): WorkspaceConfirmation {
  return {
    id,
    char,
    detail: getWorkspacesSnapshot().workspaces.find(workspace => workspace.id === id)?.name,
    canConfirm: () => !isWorkspaceTransferPending(id),
    answer: accepted => { if (accepted) void closeWorkspaceWithSurfaces(id); },
  };
}

function workspaceReopenRecord(id: WorkspaceId, session: PersistedSession): WorkspaceReopenRecord | null {
  const { workspaces } = getWorkspacesSnapshot();
  const index = workspaces.findIndex(workspace => workspace.id === id);
  if (index < 0) return null;
  const { name, nameIsAuto } = workspaces[index];
  return { kind: 'workspace', closedAt: Date.now(), workspace: { id, name, nameIsAuto, session }, index };
}

/** Open the strip's inline rename editor on a Workspace. */
export function requestWorkspaceRename(id: WorkspaceId): void {
  setRenamingWorkspace(id);
}
