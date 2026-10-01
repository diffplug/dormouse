import { clampAlertDelayMs, type AlertSettings } from './alert-settings-model';

/** The two alarm sinks (`docs/specs/alert.md` -> Alarm settings). */
export type AlertSink = 'speech' | 'push';

/** Missing fields inherit the application default; null voice selects the system voice. */
export type AlertDeliveryOverrides = Partial<Pick<AlertSettings, 'speakEnabled' | 'speakDelayMs' | 'pushEnabled' | 'pushDelayMs'>> & {
  /** A local engine voice URI; the engine default when missing or unavailable. */
  speakVoice?: string | null;
};
export type AlertDeliveryPolicy = Required<AlertDeliveryOverrides>;

export function normalizeAlertDeliveryOverrides(value: unknown): AlertDeliveryOverrides {
  if (!value || typeof value !== 'object') return {};
  const raw = value as Record<string, unknown>;
  const result: AlertDeliveryOverrides = {};
  for (const key of ['speakEnabled', 'pushEnabled'] as const) {
    if (typeof raw[key] === 'boolean') result[key] = raw[key];
  }
  for (const key of ['speakDelayMs', 'pushDelayMs'] as const) {
    if (typeof raw[key] === 'number' && Number.isFinite(raw[key])) result[key] = clampAlertDelayMs(raw[key]);
  }
  if (raw.speakVoice === null || (typeof raw.speakVoice === 'string' && raw.speakVoice.length > 0 && raw.speakVoice.length <= 1024)) {
    result.speakVoice = raw.speakVoice;
  }
  return result;
}

export function resolveAlertDeliveryPolicy(defaults: AlertSettings, overrides: AlertDeliveryOverrides = {}): AlertDeliveryPolicy {
  return {
    speakEnabled: defaults.speakEnabled, speakDelayMs: defaults.speakDelayMs,
    speakVoice: null, pushEnabled: defaults.pushEnabled, pushDelayMs: defaults.pushDelayMs,
    ...overrides,
  };
}

/** Field by field: the realm's publish dedupe, the host's recheck, and a
 *  Workspace edit that changes nothing all compare this way. */
export function sameAlertDeliveryOverrides(a: AlertDeliveryOverrides, b: AlertDeliveryOverrides): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof AlertDeliveryOverrides>;
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}
