/**
 * Per-Session reaping state (`docs/specs/dor-tool.md` -> Reaping): which Tools
 * are stopping or reaped, and what a reap kept for the rehydrate. Renderer
 * memory only — the `dehydrate` payload never reaches disk; persistence reads
 * `isToolReaped` for the durable `reaped` mark alone.
 *
 * Module scope, like the other Tool stores, so a Surface moved between Walls
 * keeps its record.
 */
import type { PersistedAlertState } from './session-types';

/** What a reap keeps for the rehydrate. */
export interface ToolReapRecord {
  /** The `dehydrate` payload the run emitted on its way out, verbatim. */
  payload: string | null;
  /** The directory the reaped run started in. */
  cwd: string | null;
  /** The Session's alert, which the host drops with the PTY and reseeds at the spawn. */
  alert: PersistedAlertState | null;
}

/** Sessions between the graceful-stop signal and their PTY's kill, each with
 *  the last payload emitted since that signal. */
const stopping = new Map<string, string | null>();
const reaped = new Map<string, ToolReapRecord>();

/** Start keeping `dehydrate` payloads for `id`: only one emitted after the
 *  graceful-stop signal counts. */
export function beginToolStop(id: string): void {
  stopping.set(id, null);
}

/** A live `dehydrate` from `id`'s output; ignored unless it is stopping. */
export function offerToolDehydrate(id: string, payload: string): void {
  if (stopping.has(id)) stopping.set(id, payload);
}

/** Stop keeping payloads for `id`, answering the last one kept. */
export function endToolStop(id: string): string | null {
  const payload = stopping.get(id) ?? null;
  stopping.delete(id);
  return payload;
}

export function isToolStopping(id: string): boolean {
  return stopping.has(id);
}

export function markToolReaped(id: string, record: ToolReapRecord): void {
  reaped.set(id, record);
}

export function isToolReaped(id: string): boolean {
  return reaped.has(id);
}

export function getToolReap(id: string): ToolReapRecord | null {
  return reaped.get(id) ?? null;
}

/** The record a rehydrate consumes: one rehydrate per reap, so a payload is
 *  handed to one run alone. */
export function takeToolReap(id: string): ToolReapRecord | null {
  const record = reaped.get(id) ?? null;
  reaped.delete(id);
  return record;
}

/** Drop a Session's reaping state when it dies, so a recycled pane id cannot
 *  inherit it. */
export function clearToolReap(id: string): void {
  stopping.delete(id);
  reaped.delete(id);
}

/** Test seam. */
export function resetToolReaps(): void {
  stopping.clear();
  reaped.clear();
}
