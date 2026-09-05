import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./platform', () => ({
  getPlatform: () => ({ alertPublishSettings: vi.fn() }),
}));

import { startAlertSpeech, toSpokenText } from './alert-speech';
import { getAlertSpeechState } from './alert-speech-state';
import { applyAlertSettingsFromHost, DEFAULT_ALERT_SETTINGS } from './alert-settings';
import { clearTerminalActivity, setTerminalActivity } from './session-activity-store';
import type { SessionStatus } from './alert-manager';
import { removeTerminalPaneState, resetTerminalPaneState } from './terminal-state-store';
import type { TerminalTitleSource } from './terminal-state';

const SPEAK_DELAY_MS = 10_000;

/** Utterances passed to the stubbed Web Speech API, in order. */
let spoken: string[];
let utterances: StubUtterance[];
let cancelCount: number;
let stopSpeech: (() => void) | null = null;

interface StubUtterance {
  text: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

/** Extra engine behavior a single test wants from the stub's `speak`. */
let onSpeak: ((utterance: StubUtterance) => void) | null = null;

function stubSpeechSynthesis(): void {
  spoken = [];
  utterances = [];
  cancelCount = 0;
  onSpeak = null;
  vi.stubGlobal('speechSynthesis', {
    speak: (utterance: StubUtterance) => {
      spoken.push(utterance.text);
      utterances.push(utterance);
      onSpeak?.(utterance);
    },
    cancel: () => { cancelCount++; },
  });
  vi.stubGlobal('SpeechSynthesisUtterance', class {
    text: string;
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(text: string) { this.text = text; }
  });
}

/** Drive one Session's projected status through the activity store. */
function setStatus(id: string, status: SessionStatus): void {
  setTerminalActivity(id, { status });
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

/**
 * Two Sessions ring inside one speak window: the first is being read aloud, the
 * second waits in the engine's queue behind it.
 */
function ringTwoWithFirstSpeaking(): void {
  start();
  ring('pty-1');
  ring('pty-2');
  vi.advanceTimersByTime(SPEAK_DELAY_MS);
  utterances[0].onstart?.();
}

beforeEach(() => {
  vi.useFakeTimers();
  stubSpeechSynthesis();
  clearTerminalActivity();
  applyAlertSettingsFromHost({ ...DEFAULT_ALERT_SETTINGS, speakEnabled: true, speakDelayMs: SPEAK_DELAY_MS });
});

afterEach(() => {
  stopSpeech?.();
  stopSpeech = null;
  for (const id of ['osc0-title', 'osc2-title', 'osc9-title']) removeTerminalPaneState(id);
  clearTerminalActivity();
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

  it('strips Unicode punctuation, symbols, and control characters', () => {
    expect(toSpokenText('**build**: eight * & 2 + 2 = 4 ✅')).toBe('build eight 2 2 4');
    expect(toSpokenText('build\u0007done\u001b')).toBe('build done');
  });

  it('elides apostrophes rather than orphaning the letter after them', () => {
    expect(toSpokenText("build didn't; it wasn’t finished")).toBe('build didnt it wasnt finished');
  });

  it('preserves letters, numbers, and combining marks from other scripts', () => {
    expect(toSpokenText('构建完成。終了コード：０')).toBe('构建完成 終了コード ０');
    expect(toSpokenText('اَلْعَرَبِيَّةُ، ٢')).toBe('اَلْعَرَبِيَّةُ ٢');
  });

  it('collapses the whitespace its own substitutions create', () => {
    expect(toSpokenText('  <a>   <b>  ')).toBe('a b');
  });

  it('caps length, since a terminal title has no useful bound', () => {
    expect(toSpokenText('x'.repeat(500))).toHaveLength(120);
  });

  it('falls back rather than handing the engine an empty utterance', () => {
    expect(toSpokenText('<>')).toBe('terminal');
    expect(toSpokenText('*** ✅')).toBe('terminal');
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
        setTerminalActivity(id, {
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

  it('publishes SPEAKING on actual start, then SPOKEN on end', () => {
    start();
    ring('pty-1');
    vi.advanceTimersByTime(SPEAK_DELAY_MS);

    expect(getAlertSpeechState('pty-1')).toBeNull();
    utterances[0].onstart?.();
    expect(getAlertSpeechState('pty-1')).toBe('speaking');

    utterances[0].onend?.();
    expect(getAlertSpeechState('pty-1')).toBe('spoken');
  });

  it('keeps SPOKEN through unrelated churn while the ring remains unresolved', () => {
    start();
    ring('pty-1');
    vi.advanceTimersByTime(SPEAK_DELAY_MS);
    utterances[0].onstart?.();
    utterances[0].onend?.();

    setTerminalActivity('pty-1', { status: 'ALERT_RINGING', todo: true });
    setStatus('another-pane', 'BUSY');
    expect(getAlertSpeechState('pty-1')).toBe('spoken');
  });

  it('cuts the utterance off and clears delivery state when the ring is attended', () => {
    start();
    ring('pty-1');
    vi.advanceTimersByTime(SPEAK_DELAY_MS);
    utterances[0].onstart?.();
    expect(getAlertSpeechState('pty-1')).toBe('speaking');

    setStatus('pty-1', 'NOTHING_TO_SHOW');
    // The announcement exists to summon the user, who is now here — the engine
    // is silenced, not merely un-rendered.
    expect(cancelCount).toBe(1);
    expect(getAlertSpeechState('pty-1')).toBeNull();

    // The engine reports the cut, and can also finish an utterance after the
    // user attends. Either stale callback must not resurrect HAS SPOKEN.
    utterances[0].onend?.();
    expect(getAlertSpeechState('pty-1')).toBeNull();
  });

  /**
   * Web Speech has no per-utterance stop, so cutting one Session off empties the
   * whole queue. Attending one Pane must not silence another Pane's alarm.
   */
  it('re-speaks the still-ringing Sessions the cut collaterally silenced', () => {
    ringTwoWithFirstSpeaking();
    expect(spoken).toHaveLength(2);

    setStatus('pty-1', 'NOTHING_TO_SHOW');

    expect(cancelCount).toBe(1);
    expect(spoken).toHaveLength(3);
    utterances[2].onstart?.();
    expect(getAlertSpeechState('pty-2')).toBe('speaking');
  });

  it('does not re-dispatch a queued utterance from an earlier ring', () => {
    ringTwoWithFirstSpeaking();

    // Resolve pty-2 while its first utterance is still queued, then ring it
    // again. The new ring must serve its own delay rather than inheriting the
    // old queued entry when pty-1 is cut off.
    setStatus('pty-2', 'NOTHING_TO_SHOW');
    ring('pty-2');
    setStatus('pty-1', 'NOTHING_TO_SHOW');

    expect(cancelCount).toBe(1);
    expect(spoken).toHaveLength(2);
    vi.advanceTimersByTime(SPEAK_DELAY_MS - 1);
    expect(spoken).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(spoken).toHaveLength(3);
  });

  /** A re-dispatch is a fresh decision to speak, held to the same gate as the first. */
  it('does not re-speak the queue when the setting went off mid-utterance', () => {
    ringTwoWithFirstSpeaking();
    applyAlertSettingsFromHost({ ...DEFAULT_ALERT_SETTINGS, speakEnabled: false });

    setStatus('pty-1', 'NOTHING_TO_SHOW');

    expect(cancelCount).toBe(1);
    expect(spoken).toHaveLength(2);
  });

  /** Only the Session being read aloud is cut; a queued one has nothing to stop. */
  it('keeps a talking Pane talking when a different, queued ring is resolved', () => {
    ringTwoWithFirstSpeaking();

    setStatus('pty-2', 'NOTHING_TO_SHOW');

    expect(cancelCount).toBe(0);
    expect(getAlertSpeechState('pty-1')).toBe('speaking');
  });

  it('does not publish a queued utterance that starts after the ring was resolved', () => {
    start();
    ring('pty-1');
    vi.advanceTimersByTime(SPEAK_DELAY_MS);

    setStatus('pty-1', 'NOTHING_TO_SHOW');
    utterances[0].onstart?.();
    utterances[0].onend?.();
    expect(getAlertSpeechState('pty-1')).toBeNull();
  });

  it('records SPOKEN after an engine error if the utterance really began', () => {
    start();
    ring('pty-1');
    vi.advanceTimersByTime(SPEAK_DELAY_MS);
    utterances[0].onstart?.();
    utterances[0].onerror?.();

    expect(getAlertSpeechState('pty-1')).toBe('spoken');
  });

  it('no-ops when the host webview has no speech backend', () => {
    vi.stubGlobal('speechSynthesis', undefined);
    start();
    ring('pty-1');

    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
    expect(getAlertSpeechState('pty-1')).toBeNull();
  });

  /**
   * An engine may dispatch `start` and then `end`/`error` synchronously inside
   * `speechSynthesis.speak()` — Chrome reports `not-allowed` that way when
   * speech is invoked without a user gesture. Nothing in the settle path may
   * depend on `speak()` having returned first, or the Session stays pinned at
   * SPEAKING for the life of the ring.
   */
  it('settles an utterance the engine resolves synchronously inside speak()', () => {
    onSpeak = (utterance) => {
      utterance.onstart?.();
      utterance.onerror?.();
    };
    start();
    ring('pty-1');
    vi.advanceTimersByTime(SPEAK_DELAY_MS);

    expect(getAlertSpeechState('pty-1')).toBe('spoken');
  });

  /**
   * Detaching handlers only stops the renderer's own state from being touched;
   * the engine still owns its queue. A webview that unmounts mid-alarm must not
   * keep talking with no visible source and no UI left to stop it.
   */
  it('silences the engine on dispose, not just its callbacks', () => {
    start();
    ring('pty-1');
    vi.advanceTimersByTime(SPEAK_DELAY_MS);
    utterances[0].onstart?.();
    expect(getAlertSpeechState('pty-1')).toBe('speaking');

    stopSpeech?.();
    stopSpeech = null;

    expect(cancelCount).toBe(1);
    expect(getAlertSpeechState('pty-1')).toBeNull();
    // A callback the engine still dispatches afterward finds nothing to touch.
    utterances[0].onend?.();
    expect(getAlertSpeechState('pty-1')).toBeNull();
  });

  /**
   * WebKit drops a wedging utterance without ever firing a callback, so nothing
   * retires it. The tracking Set must stay bounded rather than pinning a handler
   * closure per ring for the life of the app.
   */
  it('bounds tracked utterances when the engine never calls back', () => {
    start();
    for (let i = 0; i < 20; i++) {
      ring(`pty-${i}`);
      vi.advanceTimersByTime(SPEAK_DELAY_MS);
    }
    expect(spoken).toHaveLength(20);

    stopSpeech?.();
    stopSpeech = null;
    // Dispose detaches exactly what was still tracked — the bounded tail. The
    // evicted remainder is inert regardless: its generation token is gone.
    expect(utterances.filter(u => u.onend === null)).toEqual(utterances.slice(-8));
  });

  it('bounds the queued Session index when the engine silently drops utterances', () => {
    start();
    for (let i = 0; i < 20; i++) {
      ring(`pty-${i}`);
      vi.advanceTimersByTime(SPEAK_DELAY_MS);
    }

    // Make the newest utterance audible, then attend it. cancel() drops the
    // engine's entire queue, so interrupt re-dispatches every Session retained in
    // its own queued index. Only the bounded tail (8 total minus the one that just
    // started) may come back; an unbounded map would re-dispatch all other 19.
    utterances[19].onstart?.();
    setStatus('pty-19', 'NOTHING_TO_SHOW');

    expect(cancelCount).toBe(1);
    expect(spoken).toHaveLength(20 + 7);
  });
});
