/** One unresolved summons: a ring from opening to clearing. Never cold-persisted. */
export interface AlertEpisode {
  id: string;
  startedAt: number;
}

export function createAlertEpisode(): AlertEpisode {
  return { id: crypto.randomUUID(), startedAt: Date.now() };
}
