import type { WorkspaceId } from './session-types';

/**
 * The Workspace strip's two transient UI states, held outside it because the
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
}

const EMPTY: WorkspaceUiState = { renamingId: null, pendingClose: null };

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

/** Drop both (a Workspace closed, or tests). */
export function resetWorkspaceUi(): void {
  if (state === EMPTY) return;
  emit(EMPTY);
}
