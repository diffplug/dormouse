import { cfg } from '../cfg';
import { loadJson, saveJson } from './local-json-store';
import { getPlatform } from './platform';

/**
 * The app-global alarm settings edited by the Alarm settings dialog
 * (`docs/specs/alert.md` -> Alarm settings). Like the WATCHING rule set, these
 * are a property of the app, not of a Session.
 *
 * This renderer-side copy drives the UI and persists to `localStorage`. In
 * VS Code it is a mirror of the extension host's authoritative copy: the first
 * renderer seeds the host, mutations are sent as field patches, and the host
 * broadcasts its canonical snapshot to every webview. The host needs
 * `inactivityTimeoutMs` for its `AlertManager`; it relays the rest untouched so
 * two webviews cannot disagree about whether alarms speak.
 */
export interface AlertSettings {
  /** ms — how long "looking at this pane" lasts before the user counts as away. */
  inactivityTimeoutMs: number;
  /** Speak an unattended alarm out loud after `speakDelayMs`. */
  speakEnabled: boolean;
  /** ms after a ring before speaking, if the ring is still unattended. */
  speakDelayMs: number;
  /** Reserved — the push UI is rendered disabled. See `docs/specs/alert.md` -> Future. */
  pushEnabled: boolean;
  /** Reserved — see `pushEnabled`. */
  pushDelayMs: number;
}

const STORAGE_KEY = 'dormouse:alert-settings';

/** Shared bounds for every delay field. Seconds in the UI, ms on the wire. */
export const MIN_DELAY_MS = 1_000;
export const MAX_DELAY_MS = 600_000;

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  // cfg.ts stays the single source of the shipped default.
  inactivityTimeoutMs: cfg.alert.userAttention,
  speakEnabled: false,
  speakDelayMs: 10_000,
  pushEnabled: false,
  pushDelayMs: 20_000,
};

/** Force a millisecond delay into the shared bounds. The one clamp rule. */
export function clampAlertDelayMs(ms: number): number {
  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, Math.round(ms)));
}

function clampDelay(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clampAlertDelayMs(value);
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Coerce an arbitrary value into a complete `AlertSettings`. Unknown keys are
 * dropped and missing keys defaulted, so the blob evolves additively without a
 * version field — and a hand-edited `localStorage` value can never produce a
 * `NaN` timer.
 */
export function normalizeAlertSettings(value: unknown): AlertSettings {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Partial<Record<keyof AlertSettings, unknown>>;
  return {
    inactivityTimeoutMs: clampDelay(raw.inactivityTimeoutMs, DEFAULT_ALERT_SETTINGS.inactivityTimeoutMs),
    speakEnabled: bool(raw.speakEnabled, DEFAULT_ALERT_SETTINGS.speakEnabled),
    speakDelayMs: clampDelay(raw.speakDelayMs, DEFAULT_ALERT_SETTINGS.speakDelayMs),
    pushEnabled: bool(raw.pushEnabled, DEFAULT_ALERT_SETTINGS.pushEnabled),
    pushDelayMs: clampDelay(raw.pushDelayMs, DEFAULT_ALERT_SETTINGS.pushDelayMs),
  };
}

function alertSettingsEqual(a: AlertSettings, b: AlertSettings): boolean {
  return a.inactivityTimeoutMs === b.inactivityTimeoutMs
    && a.speakEnabled === b.speakEnabled
    && a.speakDelayMs === b.speakDelayMs
    && a.pushEnabled === b.pushEnabled
    && a.pushDelayMs === b.pushDelayMs;
}

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

/** Apply a field patch, persist it, and push the delta to the host. */
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
