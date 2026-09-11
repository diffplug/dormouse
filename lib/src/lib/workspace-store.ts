import { parseWorkspaceRef } from 'dor/protocol';
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

/** Whether this Window still holds the Workspace. A Wall unmounting after its
 *  Workspace was closed reads `false`, which is what stops its teardown save. */
export function hasWorkspace(id: WorkspaceId): boolean {
  return state.workspaces.some((workspace) => workspace.id === id);
}

let workspaceSequence = 0;

/** Ids the host reserved for this Window to mint from (`docs/specs/standalone.md`
 *  → "Workspace registry"): `workspace-<n>` off one counter, so a ref is stable
 *  and unique across windows. Refilled in the background; below the low-water
 *  mark a burst of creates still finds one. */
const idPool: WorkspaceId[] = [];
// A block this size, refilled this early, keeps a burst of creates ahead of
// the reservation round-trip; an exhausted pool uses an opaque UUID ref.
const ID_POOL_SIZE = 32;
const ID_POOL_LOW = 8;
let reserveIds: ((count: number) => Promise<WorkspaceId[]>) | null = null;
let refilling: Promise<void> | null = null;
/** Whether a host that mints ids is installed. Only then does a `workspace-<n>`
 *  id read as minted: a bare Wall's `DEFAULT_WORKSPACE_ID` is `workspace-1`,
 *  which beside VS Code's random ids would otherwise make one store both. */
let registryInstalled = false;

function refillIdPool(): Promise<void> {
  if (!reserveIds || refilling) return refilling ?? Promise.resolve();
  const reserve = reserveIds;
  const pending = reserve(ID_POOL_SIZE)
    .then((ids) => { if (reserveIds === reserve) idPool.push(...ids); })
    .catch((error: unknown) => {
      console.error('[workspace-store] the host did not reserve Workspace ids; using opaque ids until it does', error);
    })
    .finally(() => { if (refilling === pending) refilling = null; });
  refilling = pending;
  return pending;
}

/** Give this Window a host that mints ids. Resolves once the first block is
 *  in hand, so a create that follows never falls back to a random id. */
export function installWorkspaceIdPool(reserve: (count: number) => Promise<WorkspaceId[]>): Promise<void> {
  reserveIds = reserve;
  refilling = null;
  registryInstalled = true;
  idPool.length = 0;
  return refillIdPool();
}

/** Forget the installed pool, back to a host with no registry (tests). */
export function resetWorkspaceIdPool(): void {
  reserveIds = null;
  refilling = null;
  registryInstalled = false;
  idPool.length = 0;
}

/** Prefer a Rust-reserved number; a failed reservation must not prevent boot
 *  from installing persistence. Opaque UUIDs have stable refs too. */
export function generateWorkspaceId(): WorkspaceId {
  const reserved = idPool.shift();
  if (idPool.length < ID_POOL_LOW) void refillIdPool();
  if (reserved !== undefined) return reserved;
  if (registryInstalled) return `workspace-${crypto.randomUUID()}`;
  return `workspace-${Math.random().toString(36).slice(2, 10)}-${++workspaceSequence}`;
}

/** The registry number of a `workspace-<n>` id; a random or bare id has none. */
export function workspaceRefNumber(id: WorkspaceId): number | null {
  const match = /^workspace-(\d+)$/.exec(id);
  return match ? Number(match[1]) : null;
}

/** Positions exist only on hosts without an application-wide registry. */
function refsArePositional(): boolean {
  return !registryInstalled;
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
 * Workspace's relative order. Returns whether the list changed. Refs are
 * stable, so a reorder renames nothing (`docs/specs/dor-cli.md` → "Handle Model").
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

/** A Window that never names itself: one webview is the whole application
 *  (VS Code, Pocket, the website playground). */
const DEFAULT_WINDOW_REF = 'window:1';
let windowRef = DEFAULT_WINDOW_REF;

/**
 * Name this Window to `dor`, as `window:<label>`. Injected by a host that has
 * more than one Window and so knows its own labels — the lib cannot
 * (`docs/specs/dor-cli.md` -> "Handle Model").
 */
export function setWindowLabel(label: string): void {
  windowRef = `window:${label}`;
}

/** How this Window names itself to `dor`, which is what `dor list` reports. */
export function currentWindowRef(): string {
  return windowRef;
}

/** Whether `ref` names **this** Window — its full ref, or the bare label. A ref
 *  naming another Window is not one this Window can act on. */
export function isWindowRef(ref: string): boolean {
  const trimmed = ref.trim();
  return trimmed === windowRef || `window:${trimmed}` === windowRef;
}

/** Registry refs are stable numbers or opaque ids, independent of names and
 *  strip order. Hosts without a registry retain positional refs. */
export function workspaceRefFor(id: WorkspaceId): string {
  if (refsArePositional()) {
    const index = state.workspaces.findIndex((ws) => ws.id === id);
    return `workspace:${index === -1 ? 1 : index + 1}`;
  }
  const number = workspaceRefNumber(id);
  if (number !== null) return `workspace:${number}`;
  return `workspace:${id}`;
}

/** A Workspace a target named: its identity, plus its ref as resolved. */
export interface ResolvedWorkspace extends WorkspaceMeta {
  ref: string;
}

/** What a `workspace:<n|name>` target named, or why it named nothing. */
export type WorkspaceRefResolution =
  | ({ ok: true } & ResolvedWorkspace)
  | { ok: false; message: string };

/** Resolve the host's canonical ref first, then an unambiguous name. */
export function resolveWorkspaceRef(ref: string): WorkspaceRefResolution {
  const { target, position, name } = parseWorkspaceRef(ref);
  const found = (meta: WorkspaceMeta): WorkspaceRefResolution =>
    ({ ok: true, ...meta, ref: workspaceRefFor(meta.id) });
  if (position !== null) {
    const match = refsArePositional()
      ? state.workspaces[position - 1]
      : state.workspaces.find((ws) => workspaceRefNumber(ws.id) === position);
    if (match) return found(match);
  } else if (name) {
    const byId = registryInstalled && state.workspaces.find((ws) => ws.id === name);
    if (byId) return found(byId);
    const matches = state.workspaces.filter((workspace) => workspace.name === name);
    if (matches.length === 1) return found(matches[0]);
    if (matches.length > 1) {
      const candidates = matches
        .map((workspace) => `${workspaceRefFor(workspace.id)} ${JSON.stringify(workspace.name)}`)
        .join(', ');
      return { ok: false, message: `workspace target '${target}' matched multiple Workspaces: ${candidates}` };
    }
  }
  return { ok: false, message: `unknown workspace target '${target}'` };
}

/** Reset to the single default Workspace (fresh start / tests). */
export function resetWorkspaces(): void {
  emit(defaultState());
}
