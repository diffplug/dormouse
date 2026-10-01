import type { SessionStatus } from './alert-manager';

/** One unresolved summons, retained through animation pauses. Never cold-persisted. */
export interface AlertEpisode {
  id: string;
  startedAt: number;
}

/** An owed ring held back by recent output (`docs/specs/alert.md` -> Completion events). */
export function isAlertPaused(state: { episode?: AlertEpisode | null; status: SessionStatus }): boolean {
  return state.episode != null && state.status !== 'ALERT_RINGING';
}

export function createAlertEpisode(): AlertEpisode {
  return { id: crypto.randomUUID(), startedAt: Date.now() };
}
