import type { TerminalProtocolEvent } from './terminal-protocol';

const dirty = new Map<string, boolean>();
const listeners = new Set<() => void>();

/** Unknown is not clean. Reports from ordinary terminals remain inert until
 * a Tool-designated Surface consumes this runtime-only state. */
export function getToolDirty(id: string): boolean | null {
  return dirty.get(id) ?? null;
}

export function recordToolDirty(id: string, value: boolean | null): void {
  if (getToolDirty(id) === value) return;
  if (value === null) dirty.delete(id);
  else dirty.set(id, value);
  for (const listener of listeners) listener();
}

export function subscribeToToolDirty(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Preserve stream order across live events and raw replay. A finish is not a
 * save; only a new command or explicit report replaces the previous state. */
export function recordToolStates(id: string, events: readonly TerminalProtocolEvent[]): void {
  for (const event of events) {
    if (event.kind === 'toolState') recordToolDirty(id, event.state.dirty);
    else if (event.kind === 'semantic' && event.event.type === 'commandStart') recordToolDirty(id, null);
  }
}
