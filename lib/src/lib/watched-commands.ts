import { getStorage, loadJson, saveJson } from './local-json-store';
import { DEFAULT_WATCHED_COMMANDS } from './coding-agents';
import { getPlatform } from './platform';
import { isWatchKey, watchRuleFor } from './terminal-state';
import { getRunningCommandWatchKey } from './terminal-state-store';

/**
 * The WATCHING rule set: the command keys (`commandWatchKey` output) whose
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
  try {
    // Only an absent key gets defaults: a saved [] is an explicit opt-out, and
    // malformed saved data falls back to empty.
    if (getStorage()?.getItem(STORAGE_KEY) == null) return normalize(DEFAULT_WATCHED_COMMANDS);
  } catch {
    return [];
  }
  return normalize(loadJson<string[], string[]>(STORAGE_KEY, [], isStringArray));
}

// Dedupe and drop what can never be a rule — a key `commandWatchKey` cannot
// produce (`isWatchKey`): the key is user-visible in devtools and in the rule
// list, so a malformed entry would otherwise sit there as a row that matches
// nothing. Keys written before earlier fixes fail it: a full path mangled to
// `C:toolsclaude.exe`, a relative one to `toolsdor.cmd`, a bare launcher stored
// cleanly as `npm.cmd`. Residual: a mangled *relative* path with no suffix
// (`bin\claude` -> `binclaude`) is indistinguishable from a program actually
// named that, and survives until the user deletes it. Applied to every source:
// `localStorage` and the host's canonical snapshot, since a stale key reaches
// the mirror either way, and the fresh-install defaults, which pass the same
// gate.
function normalize(names: readonly string[]): string[] {
  return [...new Set(names.map((name) => name.trim()).filter(Boolean).filter(isWatchKey))].sort();
}

let watched: string[] = readStored();
/** `watched` as the set `watchRuleFor` matches against, rebuilt with it. */
let watchedSet = new Set(watched);
const listeners = new Set<() => void>();

function replaceWatched(next: string[]): void {
  watched = next;
  watchedSet = new Set(next);
  saveJson(STORAGE_KEY, watched);
}

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

/** The rule covering the command Session `id` is running (`watchRuleFor` of
 *  its `commandWatchKey`), or null — a bare runner rule covers every script of
 *  that runner. */
export function getRunningCommandWatchRule(id: string): string | null {
  return watchRuleFor(watchedSet, getRunningCommandWatchKey(id));
}

export function setCommandWatched(name: string, on: boolean): void {
  const trimmed = name.trim();
  // Same gate `normalize` applies on the way in, so a key that would be dropped
  // on the next reload is never stored: it would otherwise match for the rest of
  // the session and then vanish with nothing on screen to explain it.
  if (!trimmed || !isWatchKey(trimmed)) return;
  if (watchedSet.has(trimmed) === on) return;
  replaceWatched(on
    ? [...watched, trimmed].sort()
    : watched.filter((entry) => entry !== trimmed));
  getPlatform().alertSetCommandWatched(trimmed, on);
  listeners.forEach((listener) => listener());
}

/** Replace the renderer mirror with the host's canonical rule set. */
export function applyWatchedCommandsFromHost(names: string[]): void {
  const next = normalize(names);
  if (next.length === watched.length && next.every((name, index) => name === watched[index])) return;
  replaceWatched(next);
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
