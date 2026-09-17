/**
 * Per-Session record of the latest OSC 367 `state` report
 * (`docs/specs/dor-tool.md` -> Unsaved changes). Renderer-only state, fed by
 * `recordToolEvents` in `./tool-events.ts` and by hosts that forward reports.
 */

const dirty = new Map<string, boolean>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<string, boolean> | null = null;

/** Unknown is not clean. Reports from ordinary terminals remain inert until
 * a Tool-designated Surface consumes this runtime-only state. */
export function getToolDirty(id: string): boolean | null {
  return dirty.get(id) ?? null;
}

/** Copy-on-write snapshot for `useSyncExternalStore`: identity changes only
 *  when a record does. */
export function getToolDirtySnapshot(): ReadonlyMap<string, boolean> {
  return snapshot ??= new Map(dirty);
}

export function recordToolDirty(id: string, value: boolean | null): void {
  if (getToolDirty(id) === value) return;
  if (value === null) dirty.delete(id);
  else dirty.set(id, value);
  snapshot = null;
  for (const listener of listeners) listener();
}

/** Drop a Session's state when it dies, so a recycled pane id cannot inherit
 *  the previous tenant's report. */
export function clearToolDirty(id: string): void {
  recordToolDirty(id, null);
}

export function subscribeToToolDirty(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test seam. */
export function resetToolDirty(): void {
  if (dirty.size === 0) return;
  dirty.clear();
  snapshot = null;
  for (const listener of listeners) listener();
}
