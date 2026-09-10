import { snapshotNotepadForTransfer, snapshotTerminalPins, removeSurface } from '../../lib/notepad/notepad-store';
import type { TransferredPin } from '../../lib/notepad/source-link';
import { forgetHelper, getHelper } from '../../lib/helper-terminal';
import { releaseSession, serializeTerminal } from '../../lib/terminal-registry';
import type { VolatileNotepadSnapshot } from '../../lib/notepad/types';
import type { PersistedSession, PersistedWorkspace, WorkspaceId } from '../../lib/session-types';
import type { SaveOptions } from '../../lib/session-save';

/**
 * Handing a Workspace to another Window (`docs/specs/standalone.md` →
 * "Transfer"). The half that lives in the shared library: build the record,
 * take the notes, and detach every Session **without killing it**. The host
 * moves the PTY ownership and mounts the Workspace at the other end.
 *
 * Nothing here is a closure, so nothing is archived and nothing is killed.
 */

export interface WorkspaceTransferPayload {
  workspaceId: WorkspaceId;
  /** What the target restores the Workspace from. */
  workspace: PersistedWorkspace;
  /** The notes riding along; the target hydrates them. Their pins follow in
   *  the content (`captureTransferContent`), once the buffers they point
   *  into have been serialized. */
  notepad: VolatileNotepadSnapshot;
  /** Member Surfaces holding a PTY, **plus each one's helper Session**: exactly
   *  what changes ownership. A helper is not a member Surface — it has no pane
   *  and no notes — but it is a live shell owned by this Window, and one left
   *  behind is a leaked process plus a stray pane on the source's next reload.
   *  The target re-parents it: `routeUnownedPtys` and `resumeLivePtys` both
   *  place a helper by its `parentId`, which travels with it. */
  terminalIds: string[];
  /** Every member Surface, browser ones included. */
  allIds: string[];
}

export interface ReleaseForTransferDeps {
  workspaceId: WorkspaceId;
  name: string;
  /** The Workspace's record, built but not published. */
  serialize: (options?: SaveOptions) => Promise<PersistedSession>;
  /** Member Surfaces: visible panes ∪ Doors. */
  surfaceIds: () => string[];
  /** Whether a member Surface has a PTY behind it. */
  hasTerminal: (id: string) => boolean;
}

/**
 * A Workspace built for the move but still attached to this Window.
 *
 * Two-phase because the host may refuse: the target window can close between
 * the drag's last probe and the drop, and a release that ran first would leave
 * a gutted Workspace here and a live one nowhere
 * (`standalone/src/workspace-move.ts`).
 */
export interface PreparedWorkspaceTransfer {
  payload: WorkspaceTransferPayload;
  /**
   * The host took it. Forget the notes and detach every Session — **the point
   * of no return**, and never reachable from a Wall unmount.
   */
  commit(): void;
}

/**
 * Build everything the target needs, **touching nothing**.
 *
 * Order is load-bearing:
 *
 * 1. **Serialize first**, with a live cwd probe. The record reads the registry
 *    — untouched flags, retained alerts, each pane's cwd — and `commit` empties
 *    it.
 * 2. **Take the notes**, without forgetting them: a refused transfer must leave
 *    this Window exactly as it was, so there is nothing to restore on the
 *    failure path.
 * 3. **`commit` releases every Session.** Detached, never killed: the process
 *    keeps running and the target resumes over it.
 */
export async function prepareWorkspaceTransfer(
  deps: ReleaseForTransferDeps,
): Promise<PreparedWorkspaceTransfer> {
  // The cwds are probed here and nowhere else: after the commit the panes this
  // Window could ask about are gone, and the target restores from this record.
  const session = await deps.serialize({ probeCwd: true });
  const allIds = deps.surfaceIds();
  const panes = allIds.filter(deps.hasTerminal);
  // A helper rides with its source, in that order: the target's resume needs the
  // parent in the same slice to re-parent it.
  const helpers = new Map<string, string>();
  for (const id of panes) {
    const helper = getHelper(id);
    if (helper) helpers.set(id, helper.id);
  }
  const terminalIds = panes.flatMap((id) => {
    const helper = helpers.get(id);
    return helper ? [id, helper] : [id];
  });

  const notepad = snapshotNotepadForTransfer(allIds);

  return {
    payload: {
      workspaceId: deps.workspaceId,
      workspace: { id: deps.workspaceId, name: deps.name, session },
      notepad,
      terminalIds,
      allIds,
    },
    commit() {
      // Leaving them behind would show the departed Workspace's notes here.
      for (const id of allIds) removeSurface(id);
      // Forgotten before its Session goes, so the status poller stops and the
      // source pane does not re-open the helper it no longer holds.
      for (const parentId of helpers.keys()) forgetHelper(parentId);
      // Browser Surfaces need nothing: their agent-browser session lives in the
      // host, and the target reopens from the persisted params.
      for (const id of terminalIds) releaseSession(id);
    },
  };
}

/** One terminal's half of a transfer's content: what the target writes before
 *  it attaches, and where the host's replay picks up. */
export interface TransferredTerminal {
  /** The buffer as the escape stream that rebuilds it; `''` for a Session this
   *  Window no longer held. */
  serialized: string;
  /** The sidecar's output position the serialization stands at; absent when
   *  the host never stamped one, and the target then replays the whole buffer
   *  behind the serialized one. */
  mark?: number;
}

/** The second half of a transfer's payload (`docs/specs/transport.md` →
 *  "Transferring a Workspace"): captured once every terminal's mark has
 *  passed, and attached to the arrival the host queued at the invoke. */
export interface WorkspaceTransferContent {
  terminals: Record<string, TransferredTerminal>;
  pins: TransferredPin[];
}

/**
 * Serialize every terminal at its mark, and take its pins at the same instant.
 *
 * **Only after the host's `marked` line for each id**: everything this Window
 * was sent before that line is in the buffer once the write queue drains, and
 * everything after it is what the target's since-mark replay carries — the two
 * tile the stream with nothing lost and nothing twice. An id with no mark (the
 * host never answered for it) is serialized anyway and replayed whole, which
 * at worst repeats its tail.
 */
export async function captureTransferContent(
  terminalIds: readonly string[],
  marks: ReadonlyMap<string, number>,
): Promise<WorkspaceTransferContent> {
  const terminals: Record<string, TransferredTerminal> = {};
  for (const id of terminalIds) {
    const serialized = (await serializeTerminal(id)) ?? '';
    const mark = marks.get(id);
    terminals[id] = mark === undefined ? { serialized } : { serialized, mark };
  }
  return { terminals, pins: snapshotTerminalPins(terminalIds) };
}
