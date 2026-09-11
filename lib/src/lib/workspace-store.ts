import { DEFAULT_WORKSPACE_ID, DEFAULT_WORKSPACE_NAME, type WorkspaceId } from './session-types';

/**
 * In-memory model of the Window's Workspaces: the ordered list, which one is
 * active, and the container verbs (`docs/specs/glossary.md`). `WorkspaceWindow`
 * mounts one Wall per entry and the standalone strip renders it; both subscribe
 * through `useSyncExternalStore`.
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

let workspaceSequence = 0;

/** A process-unique WorkspaceId, even when the random source repeats. */
export function generateWorkspaceId(): WorkspaceId {
  return `workspace-${Math.random().toString(36).slice(2, 10)}-${++workspaceSequence}`;
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
  // Duplicate identities would let closeWorkspace remove the entire list despite
  // its last-Workspace guard. Reject the whole update before notifying listeners.
  const ids = new Set(next.workspaces.map((workspace) => workspace.id));
  if (ids.size !== next.workspaces.length) throw new Error('Duplicate Workspace id');
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

/** Activate the Workspace `delta` places from the active one, wrapping at both ends. */
export function activateAdjacentWorkspace(delta: 1 | -1): void {
  const index = state.workspaces.findIndex((ws) => ws.id === state.activeId);
  if (index === -1) return;
  const { workspaces } = state;
  setActiveWorkspace(workspaces[(index + delta + workspaces.length) % workspaces.length].id);
}

/** Activate the nth Workspace in strip order (0-based); out of range does nothing. */
export function activateWorkspaceAt(index: number): void {
  const target = state.workspaces[index];
  if (target) setActiveWorkspace(target.id);
}

export function createWorkspace(opts?: { id?: WorkspaceId; name?: string; activate?: boolean }): WorkspaceMeta {
  let id = opts?.id ?? generateWorkspaceId();
  while (state.workspaces.some((workspace) => workspace.id === id)) {
    if (opts?.id !== undefined) throw new Error(`Duplicate Workspace id: ${id}`);
    id = generateWorkspaceId();
  }
  const meta: WorkspaceMeta = { id, name: opts?.name ?? nextDefaultName() };
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

/**
 * Move a Workspace to `toIndex` (clamped into range), keeping every other
 * Workspace's relative order. Returns whether the list changed. Reordering
 * renumbers `workspace:<n>` refs, which are positional by design
 * (`docs/specs/dor-cli.md` → "Handle Model").
 */
export function moveWorkspace(id: WorkspaceId, toIndex: number): boolean {
  const from = state.workspaces.findIndex((ws) => ws.id === id);
  if (from === -1) return false;
  const to = Math.max(0, Math.min(state.workspaces.length - 1, Math.trunc(toIndex)));
  if (from === to) return false;
  const workspaces = [...state.workspaces];
  const [moved] = workspaces.splice(from, 1);
  workspaces.splice(to, 0, moved);
  emit({ ...state, workspaces });
  return true;
}

/** The only Window this build addresses; `window:<n>` beyond it is an error. */
export const WINDOW_REF = 'window:1';

/** Whether `ref` names this Window — `window:1`, or the bare `1`. */
export function isWindowRef(ref: string): boolean {
  return ref.trim() === WINDOW_REF || ref.trim() === '1';
}

/** A Workspace's positional `dor` ref. One no longer in this Window — its Wall is
 *  mid-unmount — reports the first ref, which is what a lone Workspace answers. */
export function workspaceRefFor(id: WorkspaceId): string {
  const index = state.workspaces.findIndex((ws) => ws.id === id);
  return `workspace:${index === -1 ? 1 : index + 1}`;
}

/** Resolve `workspace:<n>` or a bare `<n>` (1-based) to a Workspace id. */
export function workspaceIdForRef(ref: string): WorkspaceId | null {
  const match = /^(?:workspace:)?([1-9]\d*)$/.exec(ref.trim());
  if (!match) return null;
  return state.workspaces[Number(match[1]) - 1]?.id ?? null;
}

/** Reset to the single default Workspace (fresh start / tests). */
export function resetWorkspaces(): void {
  emit(defaultState());
}
