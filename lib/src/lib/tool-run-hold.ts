/**
 * Host holds (`docs/specs/dor-tool.md` -> Run end): the host interrupting a
 * Session's run to start its successor — an in-place restart, a preview
 * retarget, a reap's stop — so that run's end is no news. One hold silences
 * the run's command-exit alert and keeps a Tool designated until a successor
 * run starts, or finishes on boot, or the host has given up.
 *
 * Module scope, like the other Tool stores, so a Surface moved between Walls
 * keeps its hold.
 */
import { getPlatform } from './platform';
import { getTerminalPaneState } from './terminal-state-store';

/** Outlasts the host's longest wait after its interrupt: 15s for the prompt to
 *  come back, then up to 15s more for the retyped run to report. */
export const HOST_HOLD_MS = 31_000;

interface Hold {
  /** The run being interrupted, if one was running. */
  current: string | null;
  /** The finished run the shell last reported before the interrupt. */
  last: string | null;
  timer: ReturnType<typeof setTimeout>;
}

const holds = new Map<string, Hold>();
/** Sessions whose replacement the host gave up on: whatever its shell last
 *  finished, the designated run has ended. */
const lapsed = new Set<string>();
const listeners = new Set<(id: string) => void>();

/** Call just before the host's own interrupt of `id`'s run. */
export function holdForHostInterrupt(id: string): void {
  getPlatform().alertSilenceRun?.(id);
  const state = getTerminalPaneState(id);
  clearTimeout(holds.get(id)?.timer);
  lapsed.delete(id);
  holds.set(id, {
    current: state.currentCommand?.id ?? null,
    last: state.lastCommand?.id ?? null,
    timer: setTimeout(() => releaseRunHold(id), HOST_HOLD_MS),
  });
}

/** Whether the host still holds `id`'s run: no run but the interrupted one has
 *  started or finished since. Pure: an outlived hold is dropped by its timer. */
export function isRunHeld(id: string): boolean {
  const hold = holds.get(id);
  if (!hold) return false;
  const { currentCommand, lastCommand } = getTerminalPaneState(id);
  if (currentCommand && currentCommand.id !== hold.current) return false;
  return !lastCommand || lastCommand.id === hold.last || lastCommand.id === hold.current;
}

/** The host gave up waiting for a successor: what ended has ended, even
 *  behind a command the user typed meanwhile. */
export function releaseRunHold(id: string): void {
  const hold = holds.get(id);
  if (!hold) return;
  clearTimeout(hold.timer);
  holds.delete(id);
  lapsed.add(id);
  for (const listener of listeners) listener(id);
}

/** Whether `id`'s last host replacement lapsed with no designated run since. */
export function isHoldLapsed(id: string): boolean {
  return lapsed.has(id);
}

/** A designated run started, the Tool ended, or the Session became a Tool
 *  anew: a lapse no longer speaks. Every hold lapses into this set when its
 *  timer fires, successful or not; only a Tool reads it. */
export function clearHoldLapse(id: string): void {
  lapsed.delete(id);
}

export function subscribeToRunHolds(listener: (id: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** @internal */
export function _resetRunHoldsForTesting(): void {
  for (const hold of holds.values()) clearTimeout(hold.timer);
  holds.clear();
  lapsed.clear();
}
