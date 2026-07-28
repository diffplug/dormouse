import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./platform', () => ({
  getPlatform: () => ({ alertPublishSettings: vi.fn() }),
}));

import { startAlertSpeech } from './alert-speech';
import { applyAlertSettingsFromHost, DEFAULT_ALERT_SETTINGS } from './alert-settings';
import { clearPrimedActivity, primeActivity } from './session-activity-store';
import type { SessionStatus } from './activity-monitor';

const SPEAK_DELAY_MS = 10_000;

/** Utterances passed to the stubbed Web Speech API, in order. */
let spoken: string[];
let stopSpeech: (() => void) | null = null;

function stubSpeechSynthesis(): void {
  spoken = [];
  vi.stubGlobal('speechSynthesis', { speak: (u: { text: string }) => spoken.push(u.text) });
  vi.stubGlobal('SpeechSynthesisUtterance', class {
    text: string;
    constructor(text: string) { this.text = text; }
  });
}

/** Drive one Session's projected status through the activity store. */
function setStatus(id: string, status: SessionStatus): void {
  primeActivity(id, { status });
}

/**
 * Ring a Session that the store already knows about. A real pane is in the
 * activity store from the moment it is created and only reaches ALERT_RINGING
 * later, so a ring is always a transition from some earlier status — that is
 * exactly what the watcher keys on.
 */
function ring(id: string): void {
  setStatus(id, 'NOTHING_TO_SHOW');
  setStatus(id, 'ALERT_RINGING');
}

beforeEach(() => {
  vi.useFakeTimers();
  stubSpeechSynthesis();
  clearPrimedActivity();
  applyAlertSettingsFromHost({ ...DEFAULT_ALERT_SETTINGS, speakEnabled: true, speakDelayMs: SPEAK_DELAY_MS });
});

afterEach(() => {
  stopSpeech?.();
  stopSpeech = null;
  clearPrimedActivity();
  applyAlertSettingsFromHost(DEFAULT_ALERT_SETTINGS);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Start the watcher after any pre-existing state has been staged. */
function start(): void {
  stopSpeech = startAlertSpeech();
}

describe('spoken alarms', () => {
  it('speaks the pane label once the delay elapses with the ring unattended', () => {
    start();
    ring('pty-1');

    vi.advanceTimersByTime(SPEAK_DELAY_MS - 1);
    expect(spoken).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(spoken).toEqual(['terminal']);
  });

  it('stays silent when the user attends before the delay elapses', () => {
    start();
    ring('pty-1');

    vi.advanceTimersByTime(SPEAK_DELAY_MS - 1);
    setStatus('pty-1', 'NOTHING_TO_SHOW');

    vi.advanceTimersByTime(60_000);
    expect(spoken).toEqual([]);
  });

  it('stays silent when the pane is killed during the delay', () => {
    start();
    ring('pty-1');

    vi.advanceTimersByTime(SPEAK_DELAY_MS - 1);
    clearPrimedActivity('pty-1');

    vi.advanceTimersByTime(60_000);
    expect(spoken).toEqual([]);
  });

  it('speaks nothing while the setting is off', () => {
    applyAlertSettingsFromHost({ ...DEFAULT_ALERT_SETTINGS, speakEnabled: false });
    start();
    ring('pty-1');

    vi.advanceTimersByTime(60_000);
    expect(spoken).toEqual([]);
  });

  it('drops a scheduled utterance if speech is switched off during the delay', () => {
    start();
    ring('pty-1');

    vi.advanceTimersByTime(SPEAK_DELAY_MS - 1);
    applyAlertSettingsFromHost({ ...DEFAULT_ALERT_SETTINGS, speakEnabled: false });

    vi.advanceTimersByTime(60_000);
    expect(spoken).toEqual([]);
  });

  it('speaks exactly once per ring, not once per store notification', () => {
    start();
    ring('pty-1');
    // Unrelated churn in the store — a rerender, a TODO toggle, another pane.
    primeActivity('pty-1', { status: 'ALERT_RINGING', todo: true });
    setStatus('pty-2', 'BUSY');

    vi.advanceTimersByTime(60_000);
    expect(spoken).toEqual(['terminal']);
  });

  it('speaks again after a ring is cleared and a fresh one arrives', () => {
    start();
    ring('pty-1');
    vi.advanceTimersByTime(SPEAK_DELAY_MS);
    expect(spoken).toEqual(['terminal']);

    setStatus('pty-1', 'NOTHING_TO_SHOW');
    setStatus('pty-1', 'ALERT_RINGING');
    vi.advanceTimersByTime(SPEAK_DELAY_MS);
    expect(spoken).toEqual(['terminal', 'terminal']);
  });

  it('is silent for a Session first seen already ringing (restore / reconnect)', () => {
    // `docs/specs/alert.md`: a ring must come from a fresh transition, never
    // from a remount or a restored snapshot.
    setStatus('restored', 'ALERT_RINGING');
    start();

    vi.advanceTimersByTime(60_000);
    expect(spoken).toEqual([]);
  });

  it('speaks for each ringing Session independently', () => {
    start();
    ring('pty-1');
    vi.advanceTimersByTime(4_000);
    ring('pty-2');

    vi.advanceTimersByTime(SPEAK_DELAY_MS - 4_000);
    expect(spoken).toHaveLength(1);

    vi.advanceTimersByTime(4_000);
    expect(spoken).toHaveLength(2);
  });

  it('no-ops when the host webview has no speech backend', () => {
    vi.stubGlobal('speechSynthesis', undefined);
    start();
    ring('pty-1');

    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
  });

  it('cancels every pending utterance when the watcher is disposed', () => {
    start();
    ring('pty-1');

    stopSpeech?.();
    stopSpeech = null;

    vi.advanceTimersByTime(60_000);
    expect(spoken).toEqual([]);
  });
});
