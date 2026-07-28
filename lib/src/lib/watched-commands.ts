import { loadJson, saveJson } from './local-json-store';
import { getPlatform } from './platform';

/**
 * The WATCHING rule set: the bare program names (`commandArgv0` output) whose
 * Sessions run the output/silence monitor. WATCHING is a property of the
 * command, not of a Session — enabling it while `claude` runs enables it for
 * every Session running `claude`, now and later. See `docs/specs/alert.md`.
 *
 * This lives renderer-side because that is where the UI and `localStorage` are.
 * The authoritative copy for alert decisions is `AlertManager`'s, which is fed
 * by `alertSetWatchedCommands` on every mutation and once at startup — required
 * because in VS Code the manager runs in the extension host, which has no
 * `localStorage` (`docs/specs/vscode.md`).
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
  publishWatchedCommands();
  listeners.forEach((listener) => listener());
}

/**
 * Push the current rule set to the host's `AlertManager`. Called on every
 * mutation and once from `initAlertStateReceiver`, so a freshly connected host
 * (cold start, VS Code webview reload) learns the rules before any command runs.
 */
export function publishWatchedCommands(): void {
  getPlatform().alertSetWatchedCommands(watched);
}
