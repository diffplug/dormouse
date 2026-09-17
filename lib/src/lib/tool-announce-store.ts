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

/** Last-write-wins: the announcement is re-emittable, so a tool that changes
 *  its port or its name simply says so again. */
export function recordToolAnnounce(id: string, announce: ToolAnnounce | null): void {
  if (announce) announces.set(id, announce);
  else announces.delete(id);
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
