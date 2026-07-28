import { loadJson, saveJson } from './local-json-store';
import { getPlatform } from './platform';

/**
 * The WATCHING rule set: the bare program names (`commandArgv0` output) whose
 * Sessions run the output/silence monitor. WATCHING is a property of the
 * command, not of a Session — enabling it while `claude` runs enables it for
 * every Session running `claude`, now and later. See `docs/specs/alert.md`.
 *
 * This renderer-side copy drives the UI and persists to `localStorage`. In
 * VS Code it is a mirror of the extension host's authoritative copy: the first
 * renderer seeds the host, mutations are sent as individual command deltas,
 * and the host broadcasts its canonical snapshot to every webview.
 */
const STORAGE_KEY = 'dormouse:watched-commands';

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function readStored(): string[] {
  const raw = loadJson<string[], string[]>(STORAGE_KEY, [], isStringArray);
  // Dedupe and drop blanks defensively: the key is user-visible in devtools and
  // a malformed entry would otherwise show up as a blank row in the rule list.
  return [...new Set(raw.map((name) => name.trim()).filter(Boolean))].sort();
}

function normalize(names: string[]): string[] {
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))].sort();
}

let watched: string[] = readStored();
const listeners = new Set<() => void>();

export function getWatchedCommands(): string[] {
  return watched;
}

/** Stable-identity snapshot for `useSyncExternalStore`. */
export function getWatchedCommandsSnapshot(): string[] {
  return watched;
}

export function subscribeToWatchedCommands(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isCommandWatched(name: string | null | undefined): boolean {
  if (!name) return false;
  return watched.includes(name);
}

export function setCommandWatched(name: string, on: boolean): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  if (watched.includes(trimmed) === on) return;
  watched = on
    ? [...watched, trimmed].sort()
    : watched.filter((entry) => entry !== trimmed);
  saveJson(STORAGE_KEY, watched);
  getPlatform().alertSetCommandWatched(trimmed, on);
  listeners.forEach((listener) => listener());
}

/** Replace the renderer mirror with the host's canonical rule set. */
export function applyWatchedCommandsFromHost(names: string[]): void {
  const next = normalize(names);
  if (next.length === watched.length && next.every((name, index) => name === watched[index])) return;
  watched = next;
  saveJson(STORAGE_KEY, watched);
  listeners.forEach((listener) => listener());
}

/**
 * Offer the renderer's persisted rule set as the host's startup seed. In
 * multi-webview VS Code only the first seed after an extension-host start is
 * accepted; the host replies to every renderer with its canonical snapshot.
 */
export function publishWatchedCommands(): void {
  getPlatform().alertSetWatchedCommands(watched);
}
