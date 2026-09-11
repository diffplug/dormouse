import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAlertStoreHost, type AlertStoreHost } from './alert-store-host';
import { DEFAULT_ALERT_SETTINGS } from '../lib/alert-settings-model';

/**
 * One WATCHING rule set and one alarm-settings blob for every window
 * (`docs/specs/alert.md` → "Alarm settings"). What matters is that a second
 * window is *corrected* rather than allowed to replace shared state, and that
 * nothing a renderer sends is installed without revalidation.
 */

let sent: Array<{ event: string; data: unknown }>;
let host: AlertStoreHost;

const watched = (): string[][] =>
  sent.filter((message) => message.event === 'alert:watchedCommands')
    .map((message) => (message.data as { names: string[] }).names);
const settings = () =>
  sent.filter((message) => message.event === 'alert:settings')
    .map((message) => (message.data as { settings: Record<string, unknown> }).settings);

beforeEach(() => {
  sent = [];
  host = createAlertStoreHost({ send: (event, data) => sent.push({ event, data }) });
});

describe('the WATCHING rule set', () => {
  it('takes the first window\'s seed and corrects every later one', () => {
    host.handle({ op: 'initializeWatchedCommands', names: ['npm test'] });
    expect(watched().at(-1)).toEqual(['npm test']);

    // A second window offering its own persisted copy is answered with the
    // canonical set, not allowed to replace it.
    host.handle({ op: 'initializeWatchedCommands', names: ['cargo build'] });
    expect(watched().at(-1)).toEqual(['npm test']);
  });

  it('applies an edit as a delta, so a stale window cannot drop other rules', () => {
    host.handle({ op: 'initializeWatchedCommands', names: ['npm test'] });
    host.handle({ op: 'setCommandWatched', name: 'cargo build', watched: true });
    expect(watched().at(-1)).toEqual(['npm test', 'cargo build']);

    host.handle({ op: 'setCommandWatched', name: 'npm test', watched: false });
    expect(watched().at(-1)).toEqual(['cargo build']);
  });

  it('ignores a malformed edit rather than installing it', () => {
    host.handle({ op: 'initializeWatchedCommands', names: ['npm test', 42, null] });
    expect(watched().at(-1)).toEqual(['npm test']);
    const before = sent.length;
    host.handle({ op: 'setCommandWatched', name: 7, watched: 'yes' });
    host.handle({ op: 'nonsense' });
    host.handle(null);
    expect(sent).toHaveLength(before);
  });
});

describe('the alarm settings', () => {
  it('takes the first seed and corrects every later one', () => {
    host.handle({ op: 'initializeSettings', settings: { ...DEFAULT_ALERT_SETTINGS, speakEnabled: true } });
    expect(settings().at(-1)).toMatchObject({ speakEnabled: true });

    host.handle({ op: 'initializeSettings', settings: { ...DEFAULT_ALERT_SETTINGS, speakEnabled: false } });
    expect(settings().at(-1)).toMatchObject({ speakEnabled: true });
  });

  it('takes an explicit edit from any window', () => {
    host.handle({ op: 'initializeSettings', settings: DEFAULT_ALERT_SETTINGS });
    host.handle({ op: 'updateSettings', settings: { ...DEFAULT_ALERT_SETTINGS, pushEnabled: true } });
    expect(settings().at(-1)).toMatchObject({ pushEnabled: true });
  });

  it('revalidates whatever a renderer sends', () => {
    // A NaN or an absurd timer must never reach a host because a webview asked.
    host.handle({ op: 'initializeSettings', settings: { speakDelayMs: Number.NaN, pushDelayMs: 1e12 } });
    const installed = settings().at(-1)!;
    expect(installed.speakDelayMs).toBe(DEFAULT_ALERT_SETTINGS.speakDelayMs);
    expect(installed.pushDelayMs).toBeLessThanOrEqual(600_000);
  });
});

it('stops broadcasting once disposed', () => {
  host.dispose();
  host.handle({ op: 'initializeWatchedCommands', names: ['npm test'] });
  expect(sent).toEqual([]);
});

it('never rings anything: the sidecar has no AlertManager', () => {
  // The stores are memory plus a broadcast; every window applies the snapshot
  // to its own manager.
  const send = vi.fn();
  const bare = createAlertStoreHost({ send });
  bare.handle({ op: 'initializeSettings', settings: DEFAULT_ALERT_SETTINGS });
  expect(send).toHaveBeenCalledWith('alert:settings', { settings: DEFAULT_ALERT_SETTINGS });
});
