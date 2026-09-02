import { loadJson, saveJson } from './local-json-store';
import { getPlatform } from './platform';
import { WINDOWS_EXECUTABLE_SUFFIX } from './terminal-state';

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

/**
 * Whether a stored key is one `commandArgv0` can still produce. It is a bare
 * program name, so it holds no separator or legacy Windows drive prefix, and it
 * never ends in a launcher suffix — `commandProgramName` strips those. Keys
 * written before this module's fixes fail one test or the other: a full path
 * mangled to `C:toolsclaude.exe`, a relative one to `toolsdor.cmd`, and a bare
 * launcher stored cleanly as `npm.cmd`. Each can only sit in the rule list as
 * a row that matches nothing, so it is dropped rather than shown.
 *
 * Residual: a mangled *relative* path with no suffix (`bin\claude` ->
 * `binclaude`) is indistinguishable from a program actually named that, and
 * survives. The user deletes it from the rule list.
 */
function isKeyableName(name: string): boolean {
  return (
    !/[\\/]/.test(name) &&
    !/^[A-Za-z]:/.test(name) &&
    !WINDOWS_EXECUTABLE_SUFFIX.test(name)
  );
}

function readStored(): string[] {
  return normalize(loadJson<string[], string[]>(STORAGE_KEY, [], isStringArray));
}

// Dedupe and drop what can never be a rule: the key is user-visible in devtools
// and in the rule list, so a malformed entry would otherwise sit there as a row
// that matches nothing. Applied to both sources, `localStorage` and the host's
// canonical snapshot, since a stale key reaches the mirror either way.
function normalize(names: string[]): string[] {
  return [...new Set(names.map((name) => name.trim()).filter(Boolean).filter(isKeyableName))].sort();
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
  // Same gate `normalize` applies on the way in, so a key that would be dropped
  // on the next reload is never stored: it would otherwise match for the rest of
  // the session and then vanish with nothing on screen to explain it.
  if (!trimmed || !isKeyableName(trimmed)) return;
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
