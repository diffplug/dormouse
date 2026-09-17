import type { WorkspaceId } from './session-types';

/**
 * The Workspace strip's transient UI states, held outside it because the
 * command-mode `$` and `&` are heard inside a Wall while the strip lives in the
 * app bar (`docs/specs/layout.md` → "Workspaces"). The strip renders from this;
 * nothing else reads it, and nothing mounted is required to write it.
 */
export interface WorkspaceUiState {
  /** The Workspace whose inline rename editor is open. */
  renamingId: WorkspaceId | null;
  /** The Workspace awaiting its typed close confirmation, and the letter that
   *  accepts it (minted once, so a re-render cannot change the letter on screen). */
  pendingClose: { id: WorkspaceId; char: string } | null;
  /** A refused move stays visible until dismissed or retried. */
  moveError: { id: WorkspaceId; reason: string } | null;
  /** A move between Windows awaiting its typed confirmation, because it would
   *  destroy the page state of `iframeCount` iframe Surfaces; `proceed` runs the
   *  move (`docs/specs/layout.md` → "Workspaces"). */
  pendingMove: { id: WorkspaceId; char: string; iframeCount: number; proceed: () => void } | null;
}

const EMPTY: WorkspaceUiState = { renamingId: null, pendingClose: null, pendingMove: null, moveError: null };

let state: WorkspaceUiState = EMPTY;
const listeners = new Set<() => void>();

function emit(next: WorkspaceUiState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

export function subscribeToWorkspaceUi(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable snapshot reference (changes only on mutation) for `useSyncExternalStore`. */
export function getWorkspaceUiSnapshot(): WorkspaceUiState {
  return state;
}

export function setRenamingWorkspace(id: WorkspaceId | null): void {
  if (state.renamingId === id) return;
  emit({ ...state, renamingId: id });
}

export function setPendingWorkspaceClose(pending: WorkspaceUiState['pendingClose']): void {
  if (state.pendingClose?.id === pending?.id && state.pendingClose?.char === pending?.char) return;
  emit({ ...state, pendingClose: pending });
}

export function setPendingWorkspaceMove(pending: WorkspaceUiState['pendingMove']): void {
  if (state.pendingMove === pending) return;
  emit({ ...state, pendingMove: pending });
}

export function setWorkspaceMoveError(error: WorkspaceUiState['moveError']): void {
  emit({ ...state, moveError: error });
}

/** Clear every transient Workspace UI state in one notification: the host's
 *  teardown dialog taking the window, and tests. */
export function resetWorkspaceUi(): void {
  if (state === EMPTY) return;
  emit(EMPTY);
}

/** Forget only the departing Workspace's chrome, preserving sibling dialogs. */
export function dismissWorkspaceUi(id: WorkspaceId): void {
  const { renamingId, pendingClose, pendingMove, moveError } = state;
  if (renamingId !== id && pendingClose?.id !== id && pendingMove?.id !== id && moveError?.id !== id) return;
  emit({
    renamingId: renamingId === id ? null : renamingId,
    pendingClose: pendingClose?.id === id ? null : pendingClose,
    pendingMove: pendingMove?.id === id ? null : pendingMove,
    moveError: moveError?.id === id ? null : moveError,
  });
}
