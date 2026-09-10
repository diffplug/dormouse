import type { WorkspaceId } from './session-types';

/**
 * Which Surfaces belong to which Workspace, published by every mounted Wall on
 * each Lath commit (`docs/specs/layout.md` → "Workspaces"). The Activity store is
 * module-global and spans every Workspace, so this membership map is what turns it
 * into a per-Workspace projection (`computeWorkspaceUnion` in
 * `lib/src/lib/workspace-union.ts`).
 */

type Membership = ReadonlyMap<WorkspaceId, readonly string[]>;

let membership: Membership = new Map();
const listeners = new Set<() => void>();

function emit(next: Membership): void {
  membership = next;
  listeners.forEach((listener) => listener());
}

function sameIds(a: readonly string[] | undefined, b: readonly string[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** Publish a Workspace's member Surfaces (panes ∪ doors). Element-wise equal input
 *  is dropped, so a Wall may call this on every commit without waking the strip. */
export function setWorkspaceSurfaces(workspaceId: WorkspaceId, surfaceIds: readonly string[]): void {
  if (sameIds(membership.get(workspaceId), surfaceIds)) return;
  const next = new Map(membership);
  next.set(workspaceId, [...surfaceIds]);
  emit(next);
}

/** Drop a Workspace's membership entirely (its Wall is gone). */
export function clearWorkspaceSurfaces(workspaceId: WorkspaceId): void {
  if (!membership.has(workspaceId)) return;
  const next = new Map(membership);
  next.delete(workspaceId);
  emit(next);
}

/** Stable snapshot reference (changes only on mutation) for `useSyncExternalStore`. */
export function getWorkspaceSurfacesSnapshot(): Membership {
  return membership;
}

export function subscribeToWorkspaceSurfaces(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The Workspace a Surface belongs to, or null when no Wall claims it. */
export function workspaceIdForSurface(surfaceId: string): WorkspaceId | null {
  for (const [workspaceId, ids] of membership) {
    if (ids.includes(surfaceId)) return workspaceId;
  }
  return null;
}

/** Forget every Workspace's membership (tests). */
export function resetWorkspaceSurfaces(): void {
  if (membership.size === 0) return;
  emit(new Map());
}
