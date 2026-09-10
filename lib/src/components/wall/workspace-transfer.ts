import { snapshotNotepadForTransfer, removeSurface } from '../../lib/notepad/notepad-store';
import { releaseSession } from '../../lib/terminal-registry';
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
  /** The notes riding along; the target hydrates them. Pins do not travel —
   *  they are markers in xterm instances this release disposes. */
  notepad: VolatileNotepadSnapshot;
  /** Member Surfaces holding a PTY: exactly what changes ownership. */
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
 * Detach a Workspace from this Window, returning everything the target needs.
 *
 * Order is load-bearing:
 *
 * 1. **Serialize first**, with a live cwd probe. The record reads the registry
 *    — untouched flags, retained alerts, each pane's cwd — and step 3 empties
 *    it.
 * 2. **Take the notes, then forget them here.** A move is not a closure, so
 *    nothing is archived; leaving them behind would show the departed
 *    Workspace's notes in this Window.
 * 3. **Release every Session.** Detached, never killed: the process keeps
 *    running and the target resumes over it.
 */
export async function releaseWorkspaceForTransfer(
  deps: ReleaseForTransferDeps,
): Promise<WorkspaceTransferPayload> {
  // The cwds are probed here and nowhere else: after step 3 the panes this
  // Window could ask about are gone, and the target restores from this record.
  const session = await deps.serialize({ probeCwd: true });
  const allIds = deps.surfaceIds();
  const terminalIds = allIds.filter(deps.hasTerminal);

  const notepad = snapshotNotepadForTransfer(allIds);
  for (const id of allIds) removeSurface(id);

  // Browser Surfaces need nothing: their agent-browser session lives in the
  // host, and the target reopens from the persisted params.
  for (const id of terminalIds) releaseSession(id);

  return {
    workspaceId: deps.workspaceId,
    workspace: { id: deps.workspaceId, name: deps.name, session },
    notepad,
    terminalIds,
    allIds,
  };
}
