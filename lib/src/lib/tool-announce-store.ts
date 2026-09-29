/**
 * Per-Session record of the latest OSC 367 `serve` announcement
 * (`docs/specs/dor-tool.md` -> Serving, OSC 367).
 *
 * Host-parsed live events and renderer-parsed raw replay feed this store
 * through `recordToolEvents` in `./tool-events.ts`.
 * It is renderer state; owners forward announcements rather than keep a second
 * copy that cannot reach the Wall.
 *
 * **Recording is not acting.** An announcement from an ordinary terminal lands
 * here and does nothing — only a tool-designated Session reads it, and even
 * then it only *selects among* the ports the scan found. Output alone never
 * creates surfaces.
 */
import type { ToolAnnounce } from './tool-announce';

const announces = new Map<string, ToolAnnounce>();
const listeners = new Set<(id: string) => void>();

/** Last-write-wins: the announcement is re-emittable, so a tool that changes
 *  its port or its name simply says so again. */
export function recordToolAnnounce(id: string, announce: ToolAnnounce | null): void {
  if (!announce) {
    announces.delete(id);
    return;
  }
  const previous = announces.get(id);
  announces.set(id, announce);
  // The serving poll retries an unchanged destination; only a new one is news.
  if ((previous?.port ?? null) === announce.port && previous?.path === announce.path) return;
  for (const listener of listeners) listener(id);
}

/** Called with the Session id when a recorded announcement names a port or
 *  path the stored one did not, never on a clear. */
export function subscribeToToolAnnounces(listener: (id: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Drop a Session's announcement when it dies, so a recycled pane id cannot
 *  inherit the previous tenant's port hint. */
export function clearToolAnnounce(id: string): void {
  announces.delete(id);
}

export function getToolAnnounce(id: string): ToolAnnounce | null {
  return announces.get(id) ?? null;
}

/** Test seam. */
export function resetToolAnnounces(): void {
  announces.clear();
}
