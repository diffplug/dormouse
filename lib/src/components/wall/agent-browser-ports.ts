/**
 * Dev-server port → terminal-pane correlation store
 * (docs/specs/dor-agent-browser.md → "Dev-server connection").
 *
 * A browser surface header can't see other panes' open ports, so the
 * correlation lives in the Wall: it watches which loopback ports headers are
 * interested in (`useDevServerMatch` registers interest), resolves each one to
 * the terminal pane serving it (via `getOpenPorts`), and writes the result
 * back here. The header consumes the resolved `{ paneId, label }` and clicks
 * focus that pane.
 *
 * Two reference-counted channels, both consumed via useSyncExternalStore:
 *   1. "wanted" ports — the set of loopback ports headers want resolved; the
 *      Wall's correlation hook reads this and recomputes on change.
 *   2. "resolutions" — port → match | null (null = resolved, no single owner);
 *      headers read their port's entry.
 */
import { useEffect } from 'react';
import { useSyncExternalStore } from 'react';

export interface DevServerMatch {
  /** The Dormouse surface id of the terminal serving this port. */
  paneId: string;
  /** A concise label for that pane (e.g. `pnpm dev`). */
  label: string;
}

// port → number of headers currently watching it. A header increments on mount
// (or when its active URL becomes loopback) and decrements on unmount/URL
// change, so the Wall only ever resolves ports something is actually showing.
const wanted = new Map<number, number>();
const wantedListeners = new Set<() => void>();

// port → match | null. `null` means "resolved, but no single pane owns it"
// (no match, or ambiguous); absent means "not resolved yet".
const resolutions = new Map<number, DevServerMatch | null>();
const resolutionListeners = new Set<() => void>();

function emitWanted(): void {
  for (const listener of wantedListeners) listener();
}

function emitResolutions(): void {
  for (const listener of resolutionListeners) listener();
}

export function requestDevServerPort(port: number): void {
  const next = (wanted.get(port) ?? 0) + 1;
  wanted.set(port, next);
  if (next === 1) emitWanted();
}

export function releaseDevServerPort(port: number): void {
  const current = wanted.get(port);
  if (!current) return;
  if (current > 1) {
    wanted.set(port, current - 1);
    return;
  }
  wanted.delete(port);
  // Drop the stale resolution so a later watcher re-resolves from scratch
  // rather than briefly flashing a now-defunct pane.
  const hadResolution = resolutions.delete(port);
  emitWanted();
  if (hadResolution) emitResolutions();
}

export function getWantedDevServerPorts(): number[] {
  return [...wanted.keys()];
}

export function subscribeWantedDevServerPorts(listener: () => void): () => void {
  wantedListeners.add(listener);
  return () => {
    wantedListeners.delete(listener);
  };
}

function matchEqual(a: DevServerMatch | null, b: DevServerMatch | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.paneId === b.paneId && a.label === b.label;
}

export function setDevServerResolution(port: number, match: DevServerMatch | null): void {
  const prev = resolutions.get(port);
  // Keep the stored reference stable when nothing changed — useSyncExternalStore
  // requires getSnapshot to return a consistent value or it re-renders forever.
  if (prev !== undefined && matchEqual(prev, match)) return;
  resolutions.set(port, match);
  emitResolutions();
}

export function getDevServerResolution(port: number): DevServerMatch | null {
  return resolutions.get(port) ?? null;
}

export function subscribeDevServerResolutions(listener: () => void): () => void {
  resolutionListeners.add(listener);
  return () => {
    resolutionListeners.delete(listener);
  };
}

// --- reload re-validate signal ---
//
// Once a port is matched the Wall stops rescanning it (the serving pane rarely
// moves). A surface reload asks the Wall to re-validate its ports — optimistically,
// so the current chip stays put until the rescan actually disagrees.
const rescanListeners = new Set<() => void>();

export function triggerDevServerRescan(): void {
  for (const listener of rescanListeners) listener();
}

export function subscribeDevServerRescan(listener: () => void): () => void {
  rescanListeners.add(listener);
  return () => {
    rescanListeners.delete(listener);
  };
}

/** Header hook: register interest in a loopback `port` (or none) and return the
 *  pane currently serving it, or null while unresolved / unmatched. */
export function useDevServerMatch(port: number | null): DevServerMatch | null {
  useEffect(() => {
    if (port == null) return;
    requestDevServerPort(port);
    return () => releaseDevServerPort(port);
  }, [port]);

  return useSyncExternalStore(
    subscribeDevServerResolutions,
    () => (port == null ? null : getDevServerResolution(port)),
  );
}
