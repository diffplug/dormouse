/**
 * Dev-server port → terminal-pane correlation store
 * (docs/specs/dor-browser.md → "Dev-Server Chip").
 *
 * A browser surface header can't see other panes' open ports, so the
 * correlation lives in the Wall: it watches which loopback ports headers are
 * interested in (`useDevServerMatch` registers interest), resolves each one to
 * the terminal pane serving it (via `getOpenPorts`), and writes the result
 * back here. The header labels the resolved pane from its live terminal state
 * and clicks focus that pane.
 *
 * Two reference-counted channels, both consumed via useSyncExternalStore:
 *   1. "wanted" ports — the set of loopback ports headers want resolved; the
 *      Wall's correlation hook reads this and recomputes on change.
 *   2. "resolutions" — port → match | null (null = resolved, no single owner);
 *      headers read their port's entry.
 */
import { useEffect, useState } from 'react';
import { useSyncExternalStore } from 'react';
import { subscribeToActivity } from '../../lib/session-activity-store';
import { createSessionLabelMemo } from '../../lib/session-label';
import { subscribeToTerminalPaneState } from '../../lib/terminal-state-store';

/** What the Wall resolved a port to. A port stays settled while its pane is
 *  retitled in place, so the label is not stored: the header derives it live. */
export interface DevServerResolution {
  /** The Dormouse surface id of the terminal serving this port. */
  paneId: string;
  /** The pane's stored title, which the label falls back on only when its
   *  terminal state names nothing (`deriveSessionLabel`). */
  fallbackTitle: string | null;
}

export interface DevServerMatch {
  paneId: string;
  /** A concise label for that pane (e.g. `pnpm dev`), from its live state. */
  label: string;
}

// port → number of headers currently watching it. A header increments on mount
// (or when its active URL becomes loopback) and decrements on unmount/URL
// change, so the Wall only ever resolves ports something is actually showing.
const wanted = new Map<number, number>();
const wantedListeners = new Set<() => void>();

// port → resolution | null. `null` means "resolved, but no single pane owns it"
// (no match, or ambiguous); absent means "not resolved yet".
const resolutions = new Map<number, DevServerResolution | null>();
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
  // Keep the last resolution cached rather than dropping it here: releasing is
  // also what React StrictMode's mount→cleanup→mount does on every header mount,
  // and clearing it in this cleanup would blank the chip until the next scan. The
  // resolution is Wall-owned — a re-wanted port is re-validated (the Wall's
  // `settled` set drops it) and a now-defunct pane is cleared by that scan.
  emitWanted();
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

function resolutionEqual(a: DevServerResolution | null, b: DevServerResolution | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.paneId === b.paneId && a.fallbackTitle === b.fallbackTitle;
}

export function setDevServerResolution(port: number, match: DevServerResolution | null): void {
  const prev = resolutions.get(port);
  // Keep the stored reference stable when nothing changed — useSyncExternalStore
  // requires getSnapshot to return a consistent value or it re-renders forever.
  if (prev !== undefined && resolutionEqual(prev, match)) return;
  resolutions.set(port, match);
  emitResolutions();
}

export function getDevServerResolution(port: number): DevServerResolution | null {
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

function subscribeToSessionLabels(listener: () => void): () => void {
  const unsubscribeState = subscribeToTerminalPaneState(listener);
  const unsubscribeActivity = subscribeToActivity(listener);
  return () => {
    unsubscribeState();
    unsubscribeActivity();
  };
}

/** What `useDevServerMatch` answers for `port` now, read outside React: the
 *  chip a preview slot switch holds (`docs/specs/layout.md` -> Pane header). */
export function devServerMatchNow(port: number): DevServerMatch | null {
  const resolution = getDevServerResolution(port);
  return resolution ? { paneId: resolution.paneId, label: createSessionLabelMemo()(resolution.paneId, resolution.fallbackTitle) } : null;
}

/** Header hook: register interest in a loopback `port` (or none) and return the
 *  pane currently serving it, labelled as it is now, or null while unresolved /
 *  unmatched. */
export function useDevServerMatch(port: number | null): DevServerMatch | null {
  useEffect(() => {
    if (port == null) return;
    requestDevServerPort(port);
    return () => releaseDevServerPort(port);
  }, [port]);

  const resolution = useSyncExternalStore(
    subscribeDevServerResolutions,
    () => (port == null ? null : getDevServerResolution(port)),
  );
  // Every pane's output emits; the label reads only the serving pane's.
  const [sessionLabel] = useState(createSessionLabelMemo);
  const label = useSyncExternalStore(
    subscribeToSessionLabels,
    () => (resolution ? sessionLabel(resolution.paneId, resolution.fallbackTitle) : null),
  );
  return resolution && label !== null ? { paneId: resolution.paneId, label } : null;
}
