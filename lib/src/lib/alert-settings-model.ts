import { cfg } from '../cfg';

/**
 * The app-global alarm settings, their defaults, and their validation
 * (`docs/specs/alert.md` -> Alarm settings). Like the WATCHING rule set they are
 * a property of the app, not of a Session.
 *
 * Platform-free on purpose: this is what a *host* runs — the VS Code extension
 * host and the standalone sidecar both revalidate a renderer's blob through
 * `normalizeAlertSettings` before installing it, and neither has a renderer to
 * drag in. `alert-settings.ts` is the renderer's own mirror over the top.
 */
export interface AlertSettings {
  /** ms — how long "looking at this pane" lasts before the user counts as away. */
  inactivityTimeoutMs: number;
  /** Delay terminal-notification rings behind confirmed animation. */
  deferAlertsUntilQuiet: boolean;
  /** Speak an unattended alarm out loud after `speakDelayMs`. */
  speakEnabled: boolean;
  /** ms after a ring before speaking, if the ring is still unattended. */
  speakDelayMs: number;
  /** Push an unattended alarm to paired phones after `pushDelayMs`. */
  pushEnabled: boolean;
  /** ms after a ring before pushing, if the ring is still unattended. */
  pushDelayMs: number;
}

/** Shared bounds for every delay field. Seconds in the UI, ms on the wire. */
export const MIN_DELAY_MS = 1_000;
export const MAX_DELAY_MS = 600_000;

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  // cfg.ts stays the single source of the shipped default.
  inactivityTimeoutMs: cfg.alert.userAttention,
  deferAlertsUntilQuiet: false,
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
    deferAlertsUntilQuiet: bool(raw.deferAlertsUntilQuiet, DEFAULT_ALERT_SETTINGS.deferAlertsUntilQuiet),
    speakEnabled: bool(raw.speakEnabled, DEFAULT_ALERT_SETTINGS.speakEnabled),
    speakDelayMs: clampDelay(raw.speakDelayMs, DEFAULT_ALERT_SETTINGS.speakDelayMs),
    pushEnabled: bool(raw.pushEnabled, DEFAULT_ALERT_SETTINGS.pushEnabled),
    pushDelayMs: clampDelay(raw.pushDelayMs, DEFAULT_ALERT_SETTINGS.pushDelayMs),
  };
}

export function alertSettingsEqual(a: AlertSettings, b: AlertSettings): boolean {
  return a.inactivityTimeoutMs === b.inactivityTimeoutMs
    && a.deferAlertsUntilQuiet === b.deferAlertsUntilQuiet
    && a.speakEnabled === b.speakEnabled
    && a.speakDelayMs === b.speakDelayMs
    && a.pushEnabled === b.pushEnabled
    && a.pushDelayMs === b.pushDelayMs;
}
