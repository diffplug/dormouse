import { getWorkspacesSnapshot } from '../../lib/workspace-store';
import type { WorkspaceId } from '../../lib/session-types';
import type { WallBootPlans, WallBootProps } from './wall-types';

/**
 * The one source of the boot record each Workspace's Wall mounts from: the
 * restored Window's own plans, seeded at first render, plus the plan a Workspace
 * arriving from another Window brings with it (`docs/specs/standalone.md` →
 * "Transfer").
 *
 * One store rather than a latched copy per `WorkspaceWindow` render, because a
 * Workspace can **leave and come back** — dragged out and dragged in again — and
 * must then mount from the record it brought rather than the one it first booted
 * with, which would put a fresh default pane over the Sessions that just
 * arrived.
 */

const plans = new Map<WorkspaceId, WallBootProps>();
let seeded = false;
/** No plan at all: Lath's fresh branch, and what the strip's `+` gets. */
const EMPTY_PLAN: WallBootProps = {};

/**
 * Install boot's own per-Workspace plans. **Only the first call is taken**:
 * `WorkspaceWindow` renders twice under StrictMode, and both renders — and every
 * later one — must see the same records.
 */
export function seedWorkspaceBootPlans(initial: WallBootPlans): void {
  if (seeded) return;
  seeded = true;
  for (const [workspaceId, plan] of Object.entries(initial)) plans.set(workspaceId, plan);
}

/**
 * Park the plan a Workspace's Wall will mount from. **Must be set before the
 * Workspace is created**: `createWorkspace` renders the Wall synchronously, and
 * a Wall with no plan takes the fresh branch and spawns a default pane over the
 * Sessions that just arrived.
 */
export function setWorkspaceBootPlan(workspaceId: WorkspaceId, plan: WallBootProps): void {
  // Self-cleaning, keyed on the Workspace store's own lifecycle: a plan for a
  // Workspace this Window no longer holds can never be read again. Never prunes
  // the one being set — it is created next.
  const live = new Set(getWorkspacesSnapshot().workspaces.map((workspace) => workspace.id));
  for (const id of plans.keys()) {
    if (id !== workspaceId && !live.has(id)) plans.delete(id);
  }
  plans.set(workspaceId, plan);
}

/** The parked plan, or an empty one — which is the fresh branch, and what a
 *  Workspace created from the strip's `+` gets. Non-destructive: every render of
 *  a Wall must see the same record. */
export function getWorkspaceBootPlan(workspaceId: WorkspaceId): WallBootProps {
  return plans.get(workspaceId) ?? EMPTY_PLAN;
}

/** Forget every parked plan, seed included (tests). */
export function resetWorkspaceBootPlans(): void {
  plans.clear();
  seeded = false;
}
