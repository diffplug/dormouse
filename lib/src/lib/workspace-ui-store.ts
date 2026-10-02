import type { WorkspaceId } from './session-types';

/** A typed-letter question about one Workspace: its close, a cross-Window move
 *  losing iframe page state, or a Surface move refreshing an iframe. `answer`
 *  runs once, after the slot has cleared. */
export interface WorkspaceConfirmation {
  id: WorkspaceId;
  /** Minted once, so a re-render cannot change the letter on screen. */
  char: string;
  title?: string;
  detail?: string;
  cancelHint?: string;
  /** False ignores the key, leaving the question up. */
  canConfirm?: () => boolean;
  answer: (accepted: boolean) => void;
}

/**
 * The Workspace strip's transient UI states, held outside it because the
 * Workspace verbs open them from outside any component (`docs/specs/layout.md`
 * → "Workspaces"). The strip renders from this; the selection ring observes
 * rename state. Nothing mounted is required to write it.
 */
export interface WorkspaceUiState {
  /** The Workspace whose inline rename editor is open. */
  renamingId: WorkspaceId | null;
  /** The one pending confirmation; a newer one answers it no
   *  (`docs/specs/layout.md` → "Workspace lifecycle"). */
  confirmation: WorkspaceConfirmation | null;
  /** A refused move stays visible until dismissed or retried. */
  moveError: { id: WorkspaceId; reason: string } | null;
}

const EMPTY: WorkspaceUiState = { renamingId: null, confirmation: null, moveError: null };

let state: WorkspaceUiState = EMPTY;
let confirmationGeneration = 0;
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

/** Ask `next`, first answering any pending confirmation no. */
export function requestConfirmation(next: WorkspaceConfirmation): void {
  confirmationGeneration++;
  const previous = state.confirmation;
  state = { ...state, confirmation: null };
  previous?.answer(false);
  emit({ ...state, confirmation: next });
}

/** Close and move verbs call this as they start. Answer the pending question no;
 *  the returned guard prevents asynchronous preparation from raising an older
 *  question or acting after a newer verb starts, even when no question was up. */
export function cancelPendingConfirmation(): () => boolean {
  const generation = ++confirmationGeneration;
  const previous = state.confirmation;
  if (previous) {
    emit({ ...state, confirmation: null });
    previous.answer(false);
  }
  return () => generation === confirmationGeneration;
}

/** Answer `confirmation` if it is still the pending one; a stale answer is ignored. */
export function settleConfirmation(confirmation: WorkspaceConfirmation, accepted: boolean): void {
  if (state.confirmation !== confirmation) return;
  emit({ ...state, confirmation: null });
  confirmation.answer(accepted);
}

export function setWorkspaceMoveError(error: WorkspaceUiState['moveError']): void {
  emit({ ...state, moveError: error });
}

/** Clear every transient Workspace UI state in one notification: the host's
 *  teardown dialog taking the window, and tests. */
export function resetWorkspaceUi(): void {
  confirmationGeneration++;
  if (state === EMPTY) return;
  const { confirmation } = state;
  emit(EMPTY);
  confirmation?.answer(false);
}

/** Forget only the departing Workspace's chrome, preserving sibling dialogs. */
export function dismissWorkspaceUi(id: WorkspaceId): void {
  const { renamingId, confirmation, moveError } = state;
  if (renamingId !== id && confirmation?.id !== id && moveError?.id !== id) return;
  emit({
    renamingId: renamingId === id ? null : renamingId,
    confirmation: confirmation?.id === id ? null : confirmation,
    moveError: moveError?.id === id ? null : moveError,
  });
  if (confirmation?.id === id) confirmation.answer(false);
}
