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
  /** When this Workspace started ringing: the earliest ringing member's episode
   *  start, or `null` when none rings. The union's own summons, not a member's. */
  ringingSince: number | null;
}

export const EMPTY_WORKSPACE_UNION: WorkspaceUnion = { ringing: false, todo: false, count: 0, ringingSince: null };

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
  let ringingSince: number | null = null;
  for (const id of surfaceIds) {
    const state = activity.get(id);
    if (!state) continue;
    const isRinging = state.status === 'ALERT_RINGING';
    const isTodo = state.todo === true;
    if (isRinging) ringing = true;
    if (isTodo) todo = true;
    if (isRinging || isTodo) count += 1;
    // The earliest start, so a second Session joining an already-ringing
    // Workspace does not restart the tab's arrival burst.
    if (isRinging && state.episode && (ringingSince === null || state.episode.startedAt < ringingSince)) {
      ringingSince = state.episode.startedAt;
    }
  }
  return { ringing, todo, count, ringingSince };
}

/**
 * The member a Workspace tab's TODO pill enters next: the first after
 * `current` in `order` whose Activity has `todo === true`, wrapping, so
 * `current` itself comes last; from the start when `current` is null or not a
 * member; null when no member has a TODO. `order` is the Wall's member order
 * (`WallHandle.surfaceIds`). Reads only — it never touches a TODO.
 */
export function nextTodoMember(
  order: readonly string[],
  current: string | null,
  activity: Map<string, ActivityState>,
): string | null {
  const start = current === null ? -1 : order.indexOf(current);
  for (let step = 1; step <= order.length; step++) {
    const id = order[(start + step) % order.length];
    if (activity.get(id)?.todo === true) return id;
  }
  return null;
}
