import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./platform', () => ({
  getPlatform: () => ({ alertPublishSettings: vi.fn() }),
}));

import { startAlertSpeech, toSpokenText } from './alert-speech';
import { applyAlertSettingsFromHost, DEFAULT_ALERT_SETTINGS } from './alert-settings';
import { clearPrimedActivity, primeActivity } from './session-activity-store';
import type { SessionStatus } from './activity-monitor';
import { removeTerminalPaneState, resetTerminalPaneState } from './terminal-state-store';
import type { TerminalTitleSource } from './terminal-state';

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
  for (const id of ['osc0-title', 'osc2-title', 'osc9-title']) removeTerminalPaneState(id);
  clearPrimedActivity();
  applyAlertSettingsFromHost(DEFAULT_ALERT_SETTINGS);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Start the watcher after any pre-existing state has been staged. */
function start(): void {
  stopSpeech = startAlertSpeech();
}

/**
 * WebKit drops an utterance containing angle brackets and leaves the
 * synthesizer wedged for the rest of the page's life, so every later alarm is
 * silent too. Pane labels carry `<idle>` chrome, and terminal-supplied titles
 * reach speech — so this is a denial-of-service guard, not just tidiness.
 */
describe('toSpokenText', () => {
  it('strips the angle brackets that wedge the engine', () => {
    expect(toSpokenText('<idle> build finished')).toBe('idle build finished');
  });

  it('separates rather than joins, so stripped text does not run together', () => {
    expect(toSpokenText('a<b>c')).toBe('a b c');
  });

  it('strips ampersands and control characters from untrusted titles', () => {
    expect(toSpokenText('make&test')).toBe('make test');
    expect(toSpokenText('build\u0007done\u001b')).toBe('build done');
  });

  it('collapses the whitespace its own substitutions create', () => {
    expect(toSpokenText('  <a>   <b>  ')).toBe('a b');
  });

  it('caps length, since a terminal title has no useful bound', () => {
    expect(toSpokenText('x'.repeat(500))).toHaveLength(120);
  });

  it('falls back rather than handing the engine an empty utterance', () => {
    expect(toSpokenText('<>')).toBe('terminal');
    expect(toSpokenText('   ')).toBe('terminal');
  });

  it('leaves an ordinary label alone', () => {
    expect(toSpokenText('pnpm test')).toBe('pnpm test');
  });
});

/**
 * Only the speech-specific half lives here: the payload that reaches the
 * engine, and that the sink is wired to `speakEnabled`. The ring/delay/cancel
 * rules are shared with push and covered in `alert-ring-watch.test.ts`.
 */
describe('spoken alarms', () => {
  it('speaks the pane label once the delay elapses with the ring unattended', () => {
    start();
    ring('pty-1');

    vi.advanceTimersByTime(SPEAK_DELAY_MS - 1);
    expect(spoken).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(spoken).toEqual(['terminal']);
  });

  it('speaks terminal-supplied OSC 0/2/9 titles when they are the pane label', () => {
    const sources: TerminalTitleSource[] = ['osc0', 'osc2', 'osc9'];
    for (const [index, source] of sources.entries()) {
      const id = `${source}-title`;
      resetTerminalPaneState(id, {
        activity: { kind: 'running' },
        currentCommand: {
          id: `cmd-${index}`,
          rawCommandLine: 'sleep 60',
          displayCommand: 'sleep 60',
          cwdAtStart: null,
          startedAt: 10,
          source: 'osc133_boundaries',
        },
        // OSC 0/2 come from terminal semantic state. OSC 9 is exercised below
        // through the alert-backed app-title resolver used by the display label.
        titleCandidates: source === 'osc9'
          ? {}
          : { [source]: { title: `program title ${source}`, source, updatedAt: 20 } },
      });
    }

    start();
    for (const source of sources) {
      const id = `${source}-title`;
      setStatus(id, 'NOTHING_TO_SHOW');
      if (source === 'osc9') {
        primeActivity(id, {
          status: 'ALERT_RINGING',
          notification: { source: 'OSC 9', title: null, body: 'program title osc9' },
        });
      } else {
        setStatus(id, 'ALERT_RINGING');
      }
    }
    vi.advanceTimersByTime(SPEAK_DELAY_MS);

    expect(spoken).toEqual([
      'program title osc0',
      'program title osc2',
      'program title osc9',
    ]);
  });

  it('speaks nothing while speakEnabled is off', () => {
    applyAlertSettingsFromHost({ ...DEFAULT_ALERT_SETTINGS, speakEnabled: false });
    start();
    ring('pty-1');

    vi.advanceTimersByTime(60_000);
    expect(spoken).toEqual([]);
  });

  it('uses speakDelayMs as the delay', () => {
    applyAlertSettingsFromHost({
      ...DEFAULT_ALERT_SETTINGS,
      speakEnabled: true,
      speakDelayMs: 3_000,
    });
    start();
    ring('pty-1');

    vi.advanceTimersByTime(3_000);
    expect(spoken).toEqual(['terminal']);
  });

  it('no-ops when the host webview has no speech backend', () => {
    vi.stubGlobal('speechSynthesis', undefined);
    start();
    ring('pty-1');

    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
  });
});
