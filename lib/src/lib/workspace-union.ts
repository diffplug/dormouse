import type { ActivityState } from './session-activity-store';

/**
 * A Workspace's display-only **union status** over its member Surfaces'
 * Activity (`docs/specs/glossary.md`, `docs/specs/alert.md`). Derived; it never
 * enters the Activity state machine and never fires a ring.
 */
export interface WorkspaceUnion {
  /** Any member terminal Session is `ALERT_RINGING`. Browser Surfaces never ring. */
  ringing: boolean;
  /** Any member Surface (terminal or browser) has `todo === true`. */
  todo: boolean;
  /** Number of member Surfaces owing attention (ringing or todo); each counts once. */
  count: number;
}

export const EMPTY_WORKSPACE_UNION: WorkspaceUnion = { ringing: false, todo: false, count: 0 };

/**
 * Project the union over a Workspace's member Surfaces. `surfaceIds` are the
 * Workspace's panes + doors; `activity` is `getActivitySnapshot()`. Surfaces
 * with no activity entry contribute nothing. A Surface that is both ringing and
 * TODO is counted once.
 */
export function computeWorkspaceUnion(
  surfaceIds: Iterable<string>,
  activity: Map<string, ActivityState>,
): WorkspaceUnion {
  let ringing = false;
  let todo = false;
  let count = 0;
  for (const id of surfaceIds) {
    const state = activity.get(id);
    if (!state) continue;
    const isRinging = state.status === 'ALERT_RINGING';
    const isTodo = state.todo === true;
    if (isRinging) ringing = true;
    if (isTodo) todo = true;
    if (isRinging || isTodo) count += 1;
  }
  return { ringing, todo, count };
}
