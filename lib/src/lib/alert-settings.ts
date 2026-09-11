import { loadJson, saveJson } from './local-json-store';
import { getPlatform } from './platform';
import {
  alertSettingsEqual,
  normalizeAlertSettings,
  type AlertSettings,
} from './alert-settings-model';

/**
 * The renderer's copy of the app-global alarm settings: what the dialog edits
 * and what `localStorage` holds. The shape, its defaults and its validation are
 * the platform-free `alert-settings-model.ts`, so a host can run them beside
 * the PTYs (`lib/src/host/alert-store-host.ts`) without dragging a renderer in.
 *
 * Re-exported here so every existing importer keeps one name to reach for.
 */
export * from './alert-settings-model';

const STORAGE_KEY = 'dormouse:alert-settings';

let settings: AlertSettings = normalizeAlertSettings(loadJson<unknown, null>(STORAGE_KEY, null));
const listeners = new Set<() => void>();

/** Stable-identity snapshot for `useSyncExternalStore`. */
export function getAlertSettings(): AlertSettings {
  return settings;
}

export function subscribeToAlertSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Apply a field patch, persist it, and relay the whole blob to the host. */
export function updateAlertSettings(patch: Partial<AlertSettings>): void {
  const next = normalizeAlertSettings({ ...settings, ...patch });
  if (alertSettingsEqual(next, settings)) return;
  settings = next;
  saveJson(STORAGE_KEY, settings);
  getPlatform().alertPublishSettings(settings, { seed: false });
  listeners.forEach((listener) => listener());
}

/** Replace the renderer mirror with the host's canonical settings. */
export function applyAlertSettingsFromHost(value: unknown): void {
  const next = normalizeAlertSettings(value);
  if (alertSettingsEqual(next, settings)) return;
  settings = next;
  saveJson(STORAGE_KEY, settings);
  listeners.forEach((listener) => listener());
}

/**
 * Offer the renderer's persisted settings as the host's startup seed. In
 * multi-webview VS Code only the first seed after an extension-host start is
 * accepted; the host replies to every renderer with its canonical snapshot.
 */
export function publishAlertSettings(): void {
  getPlatform().alertPublishSettings(settings, { seed: true });
}
