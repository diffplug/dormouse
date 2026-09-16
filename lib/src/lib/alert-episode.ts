/** One uninterrupted interval with at least one ringing track. Never cold-persisted. */
export interface AlertEpisode {
  id: string;
  startedAt: number;
}

export function createAlertEpisode(): AlertEpisode {
  return { id: crypto.randomUUID(), startedAt: Date.now() };
}
