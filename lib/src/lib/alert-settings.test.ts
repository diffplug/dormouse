import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const alertPublishSettings = vi.fn();

vi.mock('./platform', () => ({
  getPlatform: () => ({ alertPublishSettings }),
}));

import { cfg } from '../cfg';
import {
  applyAlertSettingsFromHost,
  DEFAULT_ALERT_SETTINGS,
  getAlertSettings,
  MAX_DELAY_MS,
  MIN_DELAY_MS,
  normalizeAlertSettings,
  publishAlertSettings,
  subscribeToAlertSettings,
  updateAlertSettings,
} from './alert-settings';

const STORAGE_KEY = 'dormouse:alert-settings';

let store: Map<string, string>;

beforeEach(() => {
  store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
  applyAlertSettingsFromHost(DEFAULT_ALERT_SETTINGS);
  alertPublishSettings.mockClear();
});

afterEach(() => {
  applyAlertSettingsFromHost(DEFAULT_ALERT_SETTINGS);
  vi.unstubAllGlobals();
});

describe('normalizeAlertSettings', () => {
  it('defaults the whole blob from a missing value', () => {
    expect(normalizeAlertSettings(null)).toEqual(DEFAULT_ALERT_SETTINGS);
    expect(normalizeAlertSettings(undefined)).toEqual(DEFAULT_ALERT_SETTINGS);
    expect(normalizeAlertSettings('nonsense')).toEqual(DEFAULT_ALERT_SETTINGS);
  });

  it('seeds the inactivity timeout from cfg so cfg.ts stays the shipped default', () => {
    expect(DEFAULT_ALERT_SETTINGS.inactivityTimeoutMs).toBe(cfg.alert.userAttention);
  });

  it('fills in missing keys and drops unknown ones', () => {
    const result = normalizeAlertSettings({ speakEnabled: true, bogus: 'x' });
    expect(result).toEqual({ ...DEFAULT_ALERT_SETTINGS, speakEnabled: true });
    expect(result).not.toHaveProperty('bogus');
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a string', '5000'],
    ['null', null],
  ])('replaces a %s delay with the default rather than producing a broken timer', (_label, value) => {
    expect(normalizeAlertSettings({ speakDelayMs: value }).speakDelayMs)
      .toBe(DEFAULT_ALERT_SETTINGS.speakDelayMs);
  });

  it('clamps delays into range and rounds fractions', () => {
    expect(normalizeAlertSettings({ speakDelayMs: 0 }).speakDelayMs).toBe(MIN_DELAY_MS);
    expect(normalizeAlertSettings({ speakDelayMs: -5 }).speakDelayMs).toBe(MIN_DELAY_MS);
    expect(normalizeAlertSettings({ inactivityTimeoutMs: 10_000_000 }).inactivityTimeoutMs).toBe(MAX_DELAY_MS);
    expect(normalizeAlertSettings({ pushDelayMs: 3_000.6 }).pushDelayMs).toBe(3_001);
  });

  it('rejects non-boolean flags', () => {
    expect(normalizeAlertSettings({ speakEnabled: 'yes' }).speakEnabled).toBe(false);
    expect(normalizeAlertSettings({ speakEnabled: 1 }).speakEnabled).toBe(false);
    expect(normalizeAlertSettings({ deferAlertsUntilQuiet: 'yes' }).deferAlertsUntilQuiet).toBe(false);
  });
});

describe('updateAlertSettings', () => {
  it('merges a patch, persists it, and pushes it to the host', () => {
    updateAlertSettings({ speakEnabled: true, deferAlertsUntilQuiet: true });

    expect(getAlertSettings()).toEqual({
      ...DEFAULT_ALERT_SETTINGS,
      speakEnabled: true,
      deferAlertsUntilQuiet: true,
    });
    expect(JSON.parse(store.get(STORAGE_KEY)!)).toEqual(getAlertSettings());
    expect(alertPublishSettings).toHaveBeenCalledWith(getAlertSettings(), { seed: false });
  });

  it('clamps the patch before storing it', () => {
    updateAlertSettings({ inactivityTimeoutMs: 0 });
    expect(getAlertSettings().inactivityTimeoutMs).toBe(MIN_DELAY_MS);
  });

  it('is a no-op when nothing changes, so the host is not spammed', () => {
    updateAlertSettings({ speakEnabled: false });
    expect(alertPublishSettings).not.toHaveBeenCalled();

    updateAlertSettings({ speakEnabled: true });
    alertPublishSettings.mockClear();
    updateAlertSettings({ speakEnabled: true });
    expect(alertPublishSettings).not.toHaveBeenCalled();
  });

  it('notifies subscribers exactly once per real change', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToAlertSettings(listener);

    updateAlertSettings({ speakDelayMs: 4_000 });
    expect(listener).toHaveBeenCalledTimes(1);

    updateAlertSettings({ speakDelayMs: 4_000 });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    updateAlertSettings({ speakDelayMs: 5_000 });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('host canonical snapshot', () => {
  it('replaces the local mirror without echoing back to the host', () => {
    applyAlertSettingsFromHost({ ...DEFAULT_ALERT_SETTINGS, speakEnabled: true, speakDelayMs: 2_000 });

    expect(getAlertSettings().speakEnabled).toBe(true);
    expect(getAlertSettings().speakDelayMs).toBe(2_000);
    expect(alertPublishSettings).not.toHaveBeenCalled();
  });

  it('normalizes what the host sends', () => {
    applyAlertSettingsFromHost({ speakDelayMs: Number.NaN });
    expect(getAlertSettings().speakDelayMs).toBe(DEFAULT_ALERT_SETTINGS.speakDelayMs);
  });

  it('offers the persisted copy as the startup seed', () => {
    updateAlertSettings({ speakEnabled: true });
    publishAlertSettings();
    expect(alertPublishSettings).toHaveBeenCalledWith(getAlertSettings(), { seed: true });
  });
});
