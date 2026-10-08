import type { SessionStatus } from './alert-manager';

/** One unresolved summons, retained while deferred behind animation. Never cold-persisted. */
export interface AlertEpisode {
  id: string;
  startedAt: number;
}

/** An owed ring deferred until recent output stops (`docs/specs/alert.md` -> Completion events). */
export function isAlertDeferred(state: { episode?: AlertEpisode | null; status: SessionStatus }): boolean {
  return state.episode != null && state.status !== 'ALERT_RINGING';
}

export function createAlertEpisode(): AlertEpisode {
  return { id: crypto.randomUUID(), startedAt: Date.now() };
}
