/**
 * Per-Session record of the latest OSC 367 `serve` announcement
 * (`docs/specs/dor-tool.md` -> Serving, OSC 367).
 *
 * A module store rather than adapter plumbing: every adapter already funnels
 * PTY data through `applyTerminalProtocolEvents`, so recording here reaches the
 * Wall without a new message on four transports.
 *
 * **Recording is not acting.** An announcement from an ordinary terminal lands
 * here and does nothing — only a tool-designated Session reads it, and even
 * then it only *selects among* the ports the scan found. Output alone never
 * creates surfaces.
 */
import type { ToolAnnounce } from './tool-announce';

const announces = new Map<string, ToolAnnounce>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<string, ToolAnnounce> = new Map();

function publish(): void {
  snapshot = new Map(announces);
  for (const listener of listeners) listener();
}

/** Last-write-wins: the announcement is re-emittable, so a tool that changes
 *  its port or its name simply says so again. */
export function recordToolAnnounce(id: string, announce: ToolAnnounce): void {
  announces.set(id, announce);
  publish();
}

/** Drop a Session's announcement when it dies, so a recycled pane id cannot
 *  inherit the previous tenant's port hint. */
export function clearToolAnnounce(id: string): void {
  if (announces.delete(id)) publish();
}

export function getToolAnnounce(id: string): ToolAnnounce | null {
  return announces.get(id) ?? null;
}

export function getToolAnnounceSnapshot(): ReadonlyMap<string, ToolAnnounce> {
  return snapshot;
}

export function subscribeToToolAnnounce(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam. */
export function resetToolAnnounces(): void {
  announces.clear();
  publish();
}
