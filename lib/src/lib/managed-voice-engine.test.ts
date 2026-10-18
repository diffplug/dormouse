import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManagedVoiceEngine, type ManagedVoiceAudio, type ManagedVoicePlayback } from './managed-voice-engine';
import type { ManagedVoicePort, ManagedVoiceSpeakResult } from './platform/managed-voice-types';
import { withFallback, type SpeechEngine, type SpeechEngineCallbacks } from './speech-engine';
import { SPEECH_ENGINE_TIMEOUT_MS, SpeechQueue, type SpeechJob } from './speech-queue';

/**
 * The managed engine behind the shared queue (`docs/specs/alert.md` -> "Spoken
 * alarms"): real playback drives start/end, cancellation stops the audio and
 * ignores a late answer, and a failure before audio falls back to Web Speech.
 */

interface PendingSpeak {
  text: string;
  resolve: (result: ManagedVoiceSpeakResult) => void;
}

class FakeAudio implements ManagedVoiceAudio {
  onplaying: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  paused = true;
  playResult: Promise<void> = Promise.resolve();
  constructor(readonly url: string) {}
  play(): Promise<void> { this.paused = false; return this.playResult; }
  pause(): void { this.paused = true; }
  removeAttribute(): void {}
  load(): void {}
}

let speaks: PendingSpeak[];
let audios: FakeAudio[];
let revoked: string[];
let nextPlayResult: Promise<void> | null;
let fallbackCalls: Array<{ text: string; callbacks: SpeechEngineCallbacks; disposed: boolean | null }>;
let fallbackAvailable: boolean;
let portPresent: boolean;
let configured: boolean | null;

const port: ManagedVoicePort = {
  status: () => (configured === null ? null : { configured, voiceId: 'v', notEntitled: false }),
  subscribe: () => () => {},
  configure: async () => ({ ok: true, configured: true, voiceId: 'v', notEntitled: false }),
  speak: (text) => new Promise((resolve) => speaks.push({ text, resolve })),
};

const playback: ManagedVoicePlayback = {
  url: () => `blob:audio-${audios.length}`,
  revoke: (url) => { revoked.push(url); },
  create: (url) => {
    const audio = new FakeAudio(url);
    if (nextPlayResult) audio.playResult = nextPlayResult;
    audios.push(audio);
    return audio;
  },
};

const fallback: SpeechEngine = {
  available: () => fallbackAvailable,
  prepare(input, callbacks) {
    const call = { text: input.text, callbacks, disposed: null as boolean | null };
    fallbackCalls.push(call);
    return { start: () => {}, dispose: (cancel) => { call.disposed = cancel; } };
  },
};

let queue: SpeechQueue;
let events: string[];

function job(key: string, options: { eligible?: () => boolean } = {}): SpeechJob {
  return {
    key,
    text: () => `say ${key}`,
    eligible: options.eligible ?? (() => true),
    onStart: () => events.push(`start ${key}`),
    onFinish: (started) => events.push(`finish ${key} ${started}`),
  };
}

const audioBytes: ManagedVoiceSpeakResult = { ok: true, audio: new Uint8Array([1, 2, 3]) };
/** Let the port's promise settle and the engine's `.then` run. */
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  speaks = [];
  audios = [];
  revoked = [];
  nextPlayResult = null;
  fallbackCalls = [];
  fallbackAvailable = true;
  portPresent = true;
  configured = true;
  events = [];
  queue = new SpeechQueue(withFallback(
    createManagedVoiceEngine({ port: () => (portPresent ? port : undefined), playback }),
    fallback,
  ));
});

afterEach(() => {
  queue.clear();
  vi.useRealTimers();
});

describe('managed voice engine', () => {
  it('publishes start on audio playing and finish on audio ended', async () => {
    queue.enqueue(job('a'));
    expect(speaks.map(s => s.text)).toEqual(['say a']);
    speaks[0].resolve(audioBytes);
    await flush();
    expect(audios).toHaveLength(1);
    expect(events).toEqual([]);

    audios[0].onplaying?.();
    audios[0].onplaying?.();
    expect(events).toEqual(['start a']);
    audios[0].onended?.();
    expect(events).toEqual(['start a', 'finish a true']);
    expect(revoked).toEqual([audios[0].url]);
    expect(fallbackCalls).toHaveLength(0);
  });

  it('admits one utterance at a time across the managed attempt', async () => {
    queue.enqueue(job('a'));
    queue.enqueue(job('b'));
    expect(speaks).toHaveLength(1);
    speaks[0].resolve(audioBytes);
    await flush();
    audios[0].onplaying?.();
    audios[0].onended?.();
    expect(speaks.map(s => s.text)).toEqual(['say a', 'say b']);
  });

  it('never plays the late audio of a request cancelled mid-fetch', async () => {
    queue.enqueue(job('a'));
    queue.clear();
    expect(events).toEqual(['finish a false']);

    speaks[0].resolve(audioBytes);
    await flush();
    expect(audios).toHaveLength(0);
    expect(fallbackCalls).toHaveLength(0);
    expect(events).toEqual(['finish a false']);
  });

  it('stops audio and ignores its later events when cut off mid-playback', async () => {
    let eligible = true;
    queue.enqueue(job('a', { eligible: () => eligible }));
    speaks[0].resolve(audioBytes);
    await flush();
    const audio = audios[0];
    audio.onplaying?.();
    expect(audio.paused).toBe(false);

    eligible = false;
    queue.refresh();
    expect(audio.paused).toBe(true);
    expect(revoked).toEqual([audio.url]);
    expect(events).toEqual(['start a', 'finish a true']);
    // The element's handlers are detached; nothing late can settle anything.
    expect(audio.onended).toBeNull();
  });

  it('rechecks eligibility when audio starts', async () => {
    let eligible = true;
    queue.enqueue(job('a', { eligible: () => eligible }));
    speaks[0].resolve(audioBytes);
    await flush();
    eligible = false;
    audios[0].onplaying?.();
    expect(events).toEqual(['finish a false']);
    expect(audios[0].paused).toBe(true);
  });

  it('falls back to Web Speech for the same utterance on a host failure', async () => {
    queue.enqueue(job('a'));
    speaks[0].resolve({ ok: false, reason: 'unauthorized' });
    await flush();
    expect(audios).toHaveLength(0);
    expect(fallbackCalls.map(c => c.text)).toEqual(['say a']);

    fallbackCalls[0].callbacks.onStart();
    fallbackCalls[0].callbacks.onEnd();
    expect(events).toEqual(['start a', 'finish a true']);
    expect(fallbackCalls[0].disposed).toBe(false);
  });

  it('falls back when playback is refused before any audio', async () => {
    let refuse!: (err: unknown) => void;
    nextPlayResult = new Promise((_resolve, reject) => { refuse = reject; });
    queue.enqueue(job('a'));
    speaks[0].resolve(audioBytes);
    await flush();
    refuse(new Error('NotAllowedError'));
    await flush();
    expect(audios[0].paused).toBe(true);
    expect(revoked).toEqual([audios[0].url]);
    expect(fallbackCalls.map(c => c.text)).toEqual(['say a']);
  });

  it('never falls back once managed audio was heard', async () => {
    queue.enqueue(job('a'));
    speaks[0].resolve(audioBytes);
    await flush();
    audios[0].onplaying?.();
    audios[0].onerror?.();
    expect(fallbackCalls).toHaveLength(0);
    expect(events).toEqual(['start a', 'finish a true']);
  });

  it('finishes without fallback when playback rejects after starting', async () => {
    let refuse!: (err: unknown) => void;
    nextPlayResult = new Promise((_resolve, reject) => { refuse = reject; });
    queue.enqueue(job('a'));
    speaks[0].resolve(audioBytes);
    await flush();
    audios[0].onplaying?.();
    refuse(new Error('interrupted'));
    await flush();
    expect(fallbackCalls).toHaveLength(0);
    expect(events).toEqual(['start a', 'finish a true']);
  });

  it('ends the attempt unstarted when neither engine can speak', async () => {
    fallbackAvailable = false;
    queue.enqueue(job('a'));
    speaks[0].resolve({ ok: false, reason: 'network' });
    await flush();
    expect(events).toEqual(['finish a false']);
  });

  it('cancels the fallback utterance when cut off after falling back', async () => {
    queue.enqueue(job('a'));
    speaks[0].resolve({ ok: false, reason: 'timeout' });
    await flush();
    queue.clear();
    expect(fallbackCalls[0].disposed).toBe(true);
    // A late callback from the cancelled fallback settles nothing.
    fallbackCalls[0].callbacks.onStart();
    fallbackCalls[0].callbacks.onEnd();
    expect(events).toEqual(['finish a false']);
  });

  it('times out a stalled request and accepts none of its late callbacks', async () => {
    queue.enqueue(job('a'));
    queue.enqueue(job('b'));
    await vi.advanceTimersByTimeAsync(SPEECH_ENGINE_TIMEOUT_MS);
    expect(events).toEqual(['finish a false']);
    expect(speaks.map(s => s.text)).toEqual(['say a', 'say b']);

    speaks[0].resolve(audioBytes);
    await flush();
    expect(audios).toHaveLength(0);
    expect(fallbackCalls).toHaveLength(0);
  });

  it('is exactly the fallback engine where the host has no managed voice', () => {
    portPresent = false;
    queue.enqueue(job('a'));
    expect(speaks).toHaveLength(0);
    expect(fallbackCalls.map(c => c.text)).toEqual(['say a']);
  });

  it.each([
    ['no token', false],
    ['no status yet', null],
  ])('goes straight to the fallback engine with %s, in the same call', (_label, status) => {
    configured = status;
    queue.enqueue(job('a'));
    expect(speaks).toHaveLength(0);
    expect(fallbackCalls.map(c => c.text)).toEqual(['say a']);
  });

  it('still falls back when the host answers unconfigured', async () => {
    queue.enqueue(job('a'));
    speaks[0].resolve({ ok: false, reason: 'unconfigured' });
    await flush();
    expect(fallbackCalls.map(c => c.text)).toEqual(['say a']);
  });

  it('falls back when the primary refuses by throwing from start', () => {
    const refusing: SpeechEngine = {
      available: () => true,
      prepare: () => ({ start() { throw new Error('refused'); }, dispose() {} }),
    };
    queue = new SpeechQueue(withFallback(refusing, fallback));
    queue.enqueue(job('a'));
    expect(fallbackCalls.map(c => c.text)).toEqual(['say a']);
  });

  it('admits jobs with no Web Speech only while the host has a token', () => {
    fallbackAvailable = false;
    expect(queue.enqueue(job('a'))).toBe(true);
    configured = false;
    expect(queue.enqueue(job('b'))).toBe(false);
  });
});
