import { getWorkspacesSnapshot } from '../../lib/workspace-store';
import type { WorkspaceId } from '../../lib/session-types';
import type { WallBootProps } from './wall-types';

/**
 * The boot record a Workspace's Wall mounts from, for a Workspace that did not
 * exist at first render — one arriving from another Window
 * (`docs/specs/standalone.md` → "Transfer").
 *
 * Boot's own per-Workspace plans ride `WorkspaceWindow`'s `initialPlans` prop;
 * this is the seam for the later ones, because the plan has to be in place
 * before `createWorkspace` mounts the Wall that reads it.
 */

const plans = new Map<WorkspaceId, WallBootProps>();

/**
 * Park the plan a Workspace's Wall will mount from. **Must be set before the
 * Workspace is created**: `createWorkspace` renders the Wall synchronously, and
 * a Wall with no plan takes the fresh branch and spawns a default pane over the
 * Sessions that just arrived.
 */
export function setWorkspaceBootPlan(workspaceId: WorkspaceId, plan: WallBootProps): void {
  // Self-cleaning: a plan for a Workspace this Window no longer holds can never
  // be read again. Never prunes the one being set — it is created next.
  const live = new Set(getWorkspacesSnapshot().workspaces.map((workspace) => workspace.id));
  for (const id of plans.keys()) {
    if (id !== workspaceId && !live.has(id)) plans.delete(id);
  }
  plans.set(workspaceId, plan);
}

/** The parked plan, or undefined. Non-destructive: `WorkspaceWindow` may render
 *  twice before it mounts (StrictMode), and both renders must see the same one. */
export function getWorkspaceBootPlan(workspaceId: WorkspaceId): WallBootProps | undefined {
  return plans.get(workspaceId);
}

/** Forget every parked plan (tests). */
export function resetWorkspaceBootPlans(): void {
  plans.clear();
}
