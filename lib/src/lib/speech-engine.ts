/**
 * One way of turning an admitted utterance into sound. `SpeechQueue` owns
 * ordering, eligibility, the attempt timeout, and callback identity; an engine
 * owns only starting, reporting real playback start/end, and stopping
 * (`docs/specs/alert.md` -> "Spoken alarms").
 */
export interface SpeechEngine {
  /** False when this engine could never speak here, so admission is refused up front. */
  available(): boolean;
  /**
   * Prepare one attempt without dispatching it. The queue records the returned
   * handle before calling `start`, because an engine may report `onStart` and
   * `onEnd` synchronously inside `start` and the queue may need `dispose` from
   * inside those callbacks.
   */
  prepare(input: SpeechInput, callbacks: SpeechEngineCallbacks): SpeechAttemptHandle;
}

export interface SpeechInput {
  text: string;
  /** A local Web Speech voice URI; engines that do not use local voices ignore it. */
  voice: string | null;
}

export interface SpeechEngineCallbacks {
  /** Audio really began. At most once per attempt. */
  onStart(): void;
  /** The attempt is over — finished, failed, or refused — whether or not it started. */
  onEnd(): void;
}

export interface SpeechAttemptHandle {
  /** Dispatch. May call back synchronously; a throw is a refusal. */
  start(): void;
  /**
   * Detach the engine's callbacks; with `cancel`, also silence the engine and
   * abandon any work still in flight. Called exactly once per attempt, after
   * the queue has already revoked the attempt's identity.
   */
  dispose(cancel: boolean): void;
}

/** The browser's Web Speech engine: `window.speechSynthesis`. */
export const webSpeechEngine: SpeechEngine = {
  available: () =>
    !!globalThis.speechSynthesis && typeof globalThis.SpeechSynthesisUtterance === 'function',
  prepare(input, callbacks) {
    const synth = globalThis.speechSynthesis;
    const utterance = new globalThis.SpeechSynthesisUtterance(input.text);
    if (input.voice) {
      utterance.voice = synth.getVoices?.().find(candidate => candidate.voiceURI === input.voice) ?? null;
    }
    // Registered before dispatch: the handlers close over the utterance, never
    // over a value assigned after `speak()` returns.
    utterance.onstart = () => callbacks.onStart();
    utterance.onend = utterance.onerror = () => callbacks.onEnd();
    return {
      start: () => synth.speak(utterance),
      dispose(cancel) {
        utterance.onstart = utterance.onend = utterance.onerror = null;
        // `cancel()` may synchronously call back; the handlers are gone first.
        if (cancel) { try { synth.cancel(); } catch { /* unavailable engine */ } }
      },
    };
  },
};
