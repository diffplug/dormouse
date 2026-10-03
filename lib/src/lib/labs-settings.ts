import { getPlatformOrNull } from './platform';
import { loadJson, saveJson } from './local-json-store';

/**
 * Settings → Labs (`docs/specs/reopen.md` → "Labs: No-confirm delayed kill").
 * App-wide like every Standalone setting: every window of the app shares one
 * origin, so `localStorage` holds one value and its `storage` event tells the
 * other windows when one changes it.
 */

const DELAYED_KILL_KEY = 'dormouse.labs.delayedKill';

const listeners = new Set<() => void>();
let delayedKill = loadJson(DELAYED_KILL_KEY, false, (value): value is boolean => typeof value === 'boolean');

/** Whether this host offers Labs at all: Standalone only. */
export function labsAvailable(): boolean {
  return getPlatformOrNull()?.offersLabs === true;
}

/** No-confirm delayed kill: on only where Labs is offered and the user turned it on. */
export function isDelayedKillEnabled(): boolean {
  return delayedKill && labsAvailable();
}

/** The stored toggle, whether or not this host offers Labs (the Settings row). */
export function getDelayedKillSetting(): boolean {
  return delayedKill;
}

export function setDelayedKillSetting(on: boolean): void {
  if (on === delayedKill) return;
  delayedKill = on;
  saveJson(DELAYED_KILL_KEY, on);
  for (const listener of listeners) listener();
}

export function subscribeToLabsSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// Another window changed it.
globalThis.addEventListener?.('storage', (event: StorageEvent) => {
  if (event.key !== DELAYED_KILL_KEY) return;
  const next = loadJson(DELAYED_KILL_KEY, false, (value): value is boolean => typeof value === 'boolean');
  if (next === delayedKill) return;
  delayedKill = next;
  for (const listener of listeners) listener();
});

/** @internal */
export function _resetLabsSettingsForTesting(): void {
  delayedKill = false;
}
