import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManagedVoiceEngine, type ManagedVoiceAudio, type ManagedVoicePlayback } from './managed-voice-engine';
import type { ManagedVoicePort, ManagedVoiceSpeakResult } from './platform/managed-voice-types';
import { withFallback, type SpeechEngine, type SpeechEngineCallbacks } from './speech-engine';
import { SPEECH_ENGINE_TIMEOUT_MS, SpeechQueue, type SpeechJob } from './speech-queue';

/**
 * The managed engine behind the shared queue (`docs/specs/alert.md` -> "Spoken
 * alarms"): real playback drives start/end, cancellation reaches both the
 * request and the audio, and a failure before audio falls back to Web Speech.
 */

interface PendingSpeak {
  text: string;
  signal: AbortSignal;
  resolve: (result: ManagedVoiceSpeakResult) => void;
  reject: (err: unknown) => void;
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

const port: ManagedVoicePort = {
  offerSetup: true,
  status: async () => ({ configured: true, voiceId: 'v' }),
  configure: async () => ({ ok: true, configured: true, voiceId: 'v' }),
  speak: (text, signal) => new Promise((resolve, reject) => speaks.push({ text, signal, resolve, reject })),
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

  it('aborts the in-flight request when cancelled mid-fetch, and never plays its late audio', async () => {
    queue.enqueue(job('a'));
    queue.clear();
    expect(speaks[0].signal.aborted).toBe(true);
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

  it.each([
    ['a host failure', (s: PendingSpeak) => s.resolve({ ok: false, reason: 'unauthorized' })],
    ['a rejected request', (s: PendingSpeak) => s.reject(new Error('ipc down'))],
  ])('falls back to Web Speech for the same utterance on %s', async (_label, fail) => {
    queue.enqueue(job('a'));
    fail(speaks[0]);
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
    expect(speaks[0].signal.aborted).toBe(true);
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

  it('admits jobs with no Web Speech when the host has managed voice', () => {
    fallbackAvailable = false;
    expect(queue.enqueue(job('a'))).toBe(true);
    portPresent = false;
    expect(queue.enqueue(job('b'))).toBe(false);
  });
});
