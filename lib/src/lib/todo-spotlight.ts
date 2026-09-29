/**
 * The TODO landing spotlight: a renderer-local, one-shot signal that a Workspace
 * tab's TODO pill raises on the Surface its click entered, so that Surface's
 * pane header TODO pill plays one highlight (`docs/specs/alert.md` → Pane
 * Header).
 *
 * Only the latest signal is held: one click lands on one Surface, and a newer
 * signal ends the one before it. Every signal takes the next `seq`, so a repeat
 * click on the same Surface is a new signal and replays. Display only: never
 * Activity, never persisted, never an alert verb.
 */
export interface TodoSpotlight {
  surfaceId: string;
  seq: number;
  /** `Date.now()` when raised: the clock the pulse runs on, so a pill mounting
   *  afterwards lands where the pulse already is, or past its end. */
  startedAt: number;
}

let current: TodoSpotlight | null = null;
const listeners = new Set<() => void>();

export function spotlightTodo(surfaceId: string): void {
  current = { surfaceId, seq: (current?.seq ?? 0) + 1, startedAt: Date.now() };
  listeners.forEach((listener) => listener());
}

/** Stable snapshot reference (changes only when a signal is raised) for `useSyncExternalStore`. */
export function getTodoSpotlight(): TodoSpotlight | null {
  return current;
}

export function subscribeToTodoSpotlight(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Forget the signal (tests). */
export function resetTodoSpotlight(): void {
  current = null;
  listeners.forEach((listener) => listener());
}
