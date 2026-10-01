/** One unresolved summons, retained through animation pauses. Never cold-persisted. */
export interface AlertEpisode {
  id: string;
  startedAt: number;
}

export function createAlertEpisode(): AlertEpisode {
  return { id: crypto.randomUUID(), startedAt: Date.now() };
}
