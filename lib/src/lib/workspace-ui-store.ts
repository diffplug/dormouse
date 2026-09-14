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
  /** A move between Windows awaiting its typed confirmation, because it would
   *  destroy the page state of `iframeCount` iframe Surfaces; `proceed` runs the
   *  move (`docs/specs/layout.md` → "Workspaces"). */
  pendingMove: { id: WorkspaceId; char: string; iframeCount: number; proceed: () => void } | null;
}

const EMPTY: WorkspaceUiState = { renamingId: null, pendingClose: null, pendingMove: null };

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

/** Reset all transient Workspace UI and transfer guards (tests). */
export function resetWorkspaceUi(): void {
  pendingTransfers.clear();
  if (state === EMPTY) return;
  emit(EMPTY);
}

/** Forget only the departing Workspace's chrome, preserving sibling dialogs. */
export function dismissWorkspaceUi(id: WorkspaceId): void {
  const next = {
    renamingId: state.renamingId === id ? null : state.renamingId,
    pendingClose: state.pendingClose?.id === id ? null : state.pendingClose,
    pendingMove: state.pendingMove?.id === id ? null : state.pendingMove,
  };
  if (next.renamingId !== state.renamingId || next.pendingClose !== state.pendingClose || next.pendingMove !== state.pendingMove) emit(next);
}

// UI guard starts before the host accepts; persistence exclusion starts after.
const pendingTransfers = new Set<WorkspaceId>();
export function setWorkspaceTransferPending(id: WorkspaceId, pending: boolean): void {
  if (pending) pendingTransfers.add(id);
  else pendingTransfers.delete(id);
}
export function isWorkspaceTransferPending(id: WorkspaceId): boolean {
  return pendingTransfers.has(id);
}
