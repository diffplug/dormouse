import { speechQueue, SPEECH_ENGINE_TIMEOUT_MS } from './speech-queue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./platform', () => ({
  getPlatform: () => ({ alertPublishSettings: vi.fn() }),
}));

import { startAlertSpeech, toSpokenText, type AlertSpeaker } from './alert-speech';
import { getAlertSpeechState } from './alert-speech-state';
import { applyAlertSettingsFromHost, DEFAULT_ALERT_SETTINGS } from './alert-settings';
import { clearTerminalActivity, getActivity, setTerminalActivity } from './session-activity-store';
import type { SessionStatus } from './alert-manager';
import { removeTerminalPaneState, resetTerminalPaneState } from './terminal-state-store';
import type { TerminalTitleSource } from './terminal-state';

/** Utterances passed to the stubbed Web Speech API, in order. */
let spoken: string[];
let utterances: StubUtterance[];
let cancelCount: number;
let speaker: AlertSpeaker | null = null;

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

/** Open a new ring, and with it a new episode. */
function ring(id: string): void {
  setStatus(id, 'NOTHING_TO_SHOW');
  setStatus(id, 'ALERT_RINGING');
}

/** The host's speech deliveries come due for each Session's current episode. */
function due(...ids: string[]): void {
  for (const id of ids) speaker!.speak(id, getActivity(id).episode!.id);
}

/**
 * Two Sessions' deliveries arrive together: the first is being read aloud, the
 * second waits in Dormouse's queue behind it.
 */
function ringTwoWithFirstSpeaking(): void {
  start();
  ring('pty-1');
  ring('pty-2');
  due('pty-1', 'pty-2');
  utterances[0].onstart?.();
}

beforeEach(() => {
  vi.useFakeTimers();
  stubSpeechSynthesis();
  clearTerminalActivity();
  applyAlertSettingsFromHost({ ...DEFAULT_ALERT_SETTINGS, speakEnabled: true });
});

afterEach(() => {
  speaker?.stop();
  speaker = null;
  speechQueue.clear();
  for (const id of ['osc0-title', 'osc2-title', 'osc9-title']) removeTerminalPaneState(id);
  clearTerminalActivity();
  applyAlertSettingsFromHost(DEFAULT_ALERT_SETTINGS);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Start the performer after any pre-existing state has been staged. */
function start(): void {
  speaker = startAlertSpeech();
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

  it('redacts whole tokens before punctuation cleanup and truncation', () => {
    expect(toSpokenText('key=k8Xq+W2m/P5rZ9vN3aT6yA== done')).toBe('key REDACTED done');
    const prefix = 'build '.repeat(18);
    expect(toSpokenText(`${prefix}8b7d0c4e9f2a61035e8c9d1f04a76b23`))
      .toBe(`${prefix}REDACTED`);
  });

  it('keeps words separate when a redacted token precedes an equals sign', () => {
    expect(toSpokenText('CargoBuildFinished=ok BackgroundTaskScheduler==finished'))
      .toBe('REDACTED ok REDACTED finished');
  });
});

/**
 * The performer: what reaches the engine once the host hands this realm a
 * delivery, and what cuts it off. When a delivery comes due is the host's
 * (`alert-delivery-scheduler.test.ts`).
 */
describe('spoken alarms', () => {
  it('speaks the pane label of the episode the host hands it', () => {
    start();
    ring('pty-1');
    expect(spoken).toEqual([]);

    due('pty-1');
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
    due(...sources.map((source) => `${source}-title`));

    utterances[0].onend?.();
    utterances[1].onend?.();
    expect(spoken).toEqual([
      'program title osc0',
      'program title osc2',
      'program title osc9',
    ]);
  });

  it('drops a delivery that crossed speakEnabled turning off', () => {
    applyAlertSettingsFromHost({ ...DEFAULT_ALERT_SETTINGS, speakEnabled: false });
    start();
    ring('pty-1');
    due('pty-1');
    expect(spoken).toEqual([]);
  });

  it('drops a delivery for an episode that already ended', () => {
    start();
    ring('pty-1');
    const stale = getActivity('pty-1').episode!.id;
    ring('pty-1');
    speaker!.speak('pty-1', stale);
    expect(spoken).toEqual([]);
  });

  it('publishes SPEAKING on actual start, then SPOKEN on end', () => {
    start();
    ring('pty-1');
    due('pty-1');

    expect(getAlertSpeechState('pty-1')).toBeNull();
    utterances[0].onstart?.();
    expect(getAlertSpeechState('pty-1')).toBe('speaking');

    utterances[0].onend?.();
    expect(getAlertSpeechState('pty-1')).toBe('spoken');
  });

  it('keeps SPOKEN through unrelated churn while the ring remains unresolved', () => {
    start();
    ring('pty-1');
    due('pty-1');
    utterances[0].onstart?.();
    utterances[0].onend?.();

    setTerminalActivity('pty-1', { status: 'ALERT_RINGING', todo: true });
    setStatus('another-pane', 'BUSY');
    expect(getAlertSpeechState('pty-1')).toBe('spoken');
  });

  it('cuts the utterance off and clears delivery state when the ring clears', () => {
    start();
    ring('pty-1');
    due('pty-1');
    utterances[0].onstart?.();
    expect(getAlertSpeechState('pty-1')).toBe('speaking');

    setStatus('pty-1', 'NOTHING_TO_SHOW');
    // The announcement exists to summon the user, who is now here — the engine
    // is silenced, not merely un-rendered.
    expect(cancelCount).toBe(1);
    expect(getAlertSpeechState('pty-1')).toBeNull();

    // The engine reports the cut, and can also finish an utterance after the
    // ring clears. Either stale callback must not resurrect HAS SPOKEN.
    utterances[0].onend?.();
    expect(getAlertSpeechState('pty-1')).toBeNull();
  });

  it('admits the next still-ringing Session when the active alarm is cut off', () => {
    ringTwoWithFirstSpeaking();
    expect(spoken).toHaveLength(1);
    setStatus('pty-1', 'NOTHING_TO_SHOW');
    expect(cancelCount).toBe(1);
    expect(spoken).toHaveLength(2);
    utterances[1].onstart?.();
    expect(getAlertSpeechState('pty-2')).toBe('speaking');
  });

  it('does not re-dispatch a queued utterance from an earlier ring', () => {
    ringTwoWithFirstSpeaking();

    // Resolve pty-2 while its first utterance is still queued, then ring it
    // again. The new ring waits for its own delivery rather than inheriting
    // the old queued entry when pty-1 is cut off.
    setStatus('pty-2', 'NOTHING_TO_SHOW');
    ring('pty-2');
    setStatus('pty-1', 'NOTHING_TO_SHOW');

    expect(cancelCount).toBe(1);
    expect(spoken).toHaveLength(1);
    due('pty-2');
    expect(spoken).toHaveLength(2);
  });

  /** Turning delivery off discards pending work before native admission. */
  it('cancels pending speech when its setting turns off', () => {
    ringTwoWithFirstSpeaking();
    applyAlertSettingsFromHost({ ...DEFAULT_ALERT_SETTINGS, speakEnabled: false });

    setStatus('pty-1', 'NOTHING_TO_SHOW');

    expect(cancelCount).toBe(1);
    expect(spoken).toHaveLength(1);
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
    due('pty-1');

    setStatus('pty-1', 'NOTHING_TO_SHOW');
    utterances[0].onstart?.();
    utterances[0].onend?.();
    expect(getAlertSpeechState('pty-1')).toBeNull();
  });

  it('records SPOKEN after an engine error if the utterance really began', () => {
    start();
    ring('pty-1');
    due('pty-1');
    utterances[0].onstart?.();
    utterances[0].onerror?.();

    expect(getAlertSpeechState('pty-1')).toBe('spoken');
  });

  it('ignores an older ring starting after a newer ring has begun speaking', () => {
    start();
    ring('pty-1');
    due('pty-1');
    const oldStart = utterances[0].onstart;
    const oldEnd = utterances[0].onend;
    ring('pty-1');
    due('pty-1');
    const current = utterances[1];
    current.onstart?.();
    oldStart?.();
    oldEnd?.();
    expect(getAlertSpeechState('pty-1')).toBe('speaking');
    current.onend?.();
    expect(getAlertSpeechState('pty-1')).toBe('spoken');
  });

  it('never admits a resolved queued alarm to the speech engine', () => {
    ringTwoWithFirstSpeaking();
    setStatus('pty-2', 'NOTHING_TO_SHOW');
    expect(cancelCount).toBe(0);
    utterances[0].onend?.();
    expect(spoken).toHaveLength(1);
    expect(getAlertSpeechState('pty-2')).toBeNull();
  });

  it('no-ops when the host webview has no speech backend', () => {
    vi.stubGlobal('speechSynthesis', undefined);
    start();
    ring('pty-1');

    expect(() => due('pty-1')).not.toThrow();
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
    due('pty-1');

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
    due('pty-1');
    utterances[0].onstart?.();
    expect(getAlertSpeechState('pty-1')).toBe('speaking');

    speaker?.stop();
    speaker = null;

    expect(cancelCount).toBe(1);
    expect(getAlertSpeechState('pty-1')).toBeNull();
    // A callback the engine still dispatches afterward finds nothing to touch.
    utterances[0].onend?.();
    expect(getAlertSpeechState('pty-1')).toBeNull();
  });

  it('recovers from a callback-less engine without accepting its later callbacks', () => {
    start();
    ring('pty-1');
    ring('pty-2');
    due('pty-1', 'pty-2');
    const lateStart = utterances[0].onstart;
    const lateEnd = utterances[0].onend;
    expect(spoken).toHaveLength(1);
    vi.advanceTimersByTime(SPEECH_ENGINE_TIMEOUT_MS);
    expect(cancelCount).toBe(1);
    expect(spoken).toHaveLength(2);
    utterances[1].onstart?.();
    lateStart?.();
    lateEnd?.();
    expect(getAlertSpeechState('pty-1')).toBeNull();
    expect(getAlertSpeechState('pty-2')).toBe('speaking');
  });

  it('bounds the pending queue without feeding an unbounded browser backlog', () => {
    start();
    for (let i = 0; i < 100; i++) ring(`pty-${i}`);
    for (let i = 0; i < 100; i++) due(`pty-${i}`);
    expect(spoken).toHaveLength(1);
    for (let i = 0; i < 65; i++) utterances[i].onend?.();
    expect(spoken).toHaveLength(65);
    expect(utterances.every(utterance => utterance.onend === null)).toBe(true);
  });
});
