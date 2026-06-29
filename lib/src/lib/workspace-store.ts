import { DEFAULT_WORKSPACE_ID, DEFAULT_WORKSPACE_NAME, type WorkspaceId } from './session-types';

/**
 * In-memory model of the Window's Workspaces (stage 2b). Holds the ordered list
 * and which one is active, plus the container verbs (`docs/specs/glossary.md`).
 * Stage 3 binds the standalone strip to this via `useSyncExternalStore`; stage 4
 * wires the verbs to actual Wall mount/unmount. Until then the model defaults to
 * a single Workspace and the verbs only mutate the model.
 */

export interface WorkspaceMeta {
  id: WorkspaceId;
  name: string;
}

export interface WorkspacesState {
  workspaces: WorkspaceMeta[];
  activeId: WorkspaceId;
}

function defaultState(): WorkspacesState {
  return {
    workspaces: [{ id: DEFAULT_WORKSPACE_ID, name: DEFAULT_WORKSPACE_NAME }],
    activeId: DEFAULT_WORKSPACE_ID,
  };
}

let state: WorkspacesState = defaultState();
const listeners = new Set<() => void>();
let idSeq = 0;

function emit(next: WorkspacesState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

export function subscribeToWorkspaces(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable snapshot reference (changes only on mutation) for `useSyncExternalStore`. */
export function getWorkspacesSnapshot(): WorkspacesState {
  return state;
}

export function getActiveWorkspaceId(): WorkspaceId {
  return state.activeId;
}

/** A process-unique WorkspaceId. Never collides with `DEFAULT_WORKSPACE_ID`. */
export function generateWorkspaceId(): WorkspaceId {
  idSeq += 1;
  return `workspace-${idSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

/** "Workspace N", one past the highest existing `Workspace <n>` name. */
function nextDefaultName(): string {
  let max = 0;
  for (const ws of state.workspaces) {
    const match = /^Workspace (\d+)$/.exec(ws.name);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `Workspace ${max + 1}`;
}

/** Replace the whole model (used on restore to load the persisted Window). */
export function setWorkspaces(next: WorkspacesState): void {
  if (next.workspaces.length === 0) {
    emit(defaultState());
    return;
  }
  const activeId = next.workspaces.some((ws) => ws.id === next.activeId)
    ? next.activeId
    : next.workspaces[0].id;
  emit({ workspaces: [...next.workspaces], activeId });
}

export function setActiveWorkspace(id: WorkspaceId): void {
  if (id === state.activeId) return;
  if (!state.workspaces.some((ws) => ws.id === id)) return;
  emit({ ...state, activeId: id });
}

export function createWorkspace(opts?: { id?: WorkspaceId; name?: string; activate?: boolean }): WorkspaceMeta {
  const meta: WorkspaceMeta = { id: opts?.id ?? generateWorkspaceId(), name: opts?.name ?? nextDefaultName() };
  const activeId = opts?.activate === false ? state.activeId : meta.id;
  emit({ workspaces: [...state.workspaces, meta], activeId });
  return meta;
}

export function renameWorkspace(id: WorkspaceId, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  if (!state.workspaces.some((ws) => ws.id === id)) return;
  emit({
    ...state,
    workspaces: state.workspaces.map((ws) => (ws.id === id ? { ...ws, name: trimmed } : ws)),
  });
}

/**
 * Remove a Workspace. The last remaining Workspace cannot be closed (there is
 * always one active Workspace — glossary lifecycle). Closing the active one
 * activates its previous neighbor. Returns whether a Workspace was removed.
 */
export function closeWorkspace(id: WorkspaceId): boolean {
  if (state.workspaces.length <= 1) return false;
  const index = state.workspaces.findIndex((ws) => ws.id === id);
  if (index === -1) return false;
  const workspaces = state.workspaces.filter((ws) => ws.id !== id);
  const activeId = state.activeId === id ? workspaces[Math.max(0, index - 1)].id : state.activeId;
  emit({ workspaces, activeId });
  return true;
}

/** Reset to the single default Workspace (fresh start / tests). */
export function resetWorkspaces(): void {
  idSeq = 0;
  emit(defaultState());
}
