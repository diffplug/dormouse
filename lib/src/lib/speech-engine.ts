/**
 * One way of turning an admitted utterance into sound. `SpeechQueue` owns
 * ordering, eligibility, the attempt timeout, and callback identity; an engine
 * owns only starting, reporting real playback start/end, and stopping
 * (`docs/specs/alert.md` -> "Spoken alarms").
 */
export interface SpeechEngine {
  /** False when this engine could never speak here. */
  available(): boolean;
  /**
   * Prepare one attempt without dispatching it. The queue records the returned
   * handle before calling `start`, because an engine may call back
   * synchronously inside `start` and the queue may need `dispose` from there.
   */
  prepare(input: SpeechInput, callbacks: SpeechEngineCallbacks): SpeechAttemptHandle;
}

export interface SpeechInput {
  text: string;
  /** A local Web Speech voice URI; engines that do not use local voices ignore it. */
  voice: string | null;
}

export interface SpeechEngineCallbacks {
  /** Audio really began. */
  onStart(): void;
  /** The attempt is over after `onStart` — finished or failed. */
  onEnd(): void;
  /** The attempt is over and nothing was heard. */
  onFail(): void;
}

export interface SpeechAttemptHandle {
  /** Dispatch. May call back synchronously; a throw is a refusal. */
  start(): void;
  /**
   * Detach the engine's callbacks; with `cancel`, also silence the engine and
   * abandon any work still in flight. Called once per attempt, after the queue
   * has already revoked the attempt's identity.
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
    let started = false;
    // Registered before dispatch: the handlers close over the utterance, never
    // over a value assigned after `speak()` returns.
    utterance.onstart = () => { started = true; callbacks.onStart(); };
    utterance.onend = utterance.onerror = () => (started ? callbacks.onEnd() : callbacks.onFail());
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

/**
 * `primary` where available, else `secondary`; a `primary` attempt that fails
 * before anything was heard is retried once through `secondary` within the same
 * attempt (`docs/specs/alert.md` -> "Managed voice").
 */
export function withFallback(primary: SpeechEngine, secondary: SpeechEngine): SpeechEngine {
  return {
    available: () => primary.available() || secondary.available(),
    prepare(input, callbacks) {
      if (!primary.available()) return secondary.prepare(input, callbacks);
      let live = true;
      let heard = false;
      let first: SpeechAttemptHandle | null = null;
      let second: SpeechAttemptHandle | null = null;
      const fallBack = () => {
        if (!live) return;
        // Never both: a primary that was heard ends the attempt instead.
        if (heard || !secondary.available()) { (heard ? callbacks.onEnd : callbacks.onFail)(); return; }
        first?.dispose(false);
        first = null;
        try {
          second = secondary.prepare(input, callbacks);
          second.start();
        } catch {
          if (live) callbacks.onFail();
        }
      };
      first = primary.prepare(input, {
        onStart: () => { heard = true; callbacks.onStart(); },
        onEnd: callbacks.onEnd,
        onFail: fallBack,
      });
      return {
        start() {
          try { first?.start(); } catch { fallBack(); }
        },
        dispose(cancel) {
          live = false;
          first?.dispose(cancel);
          second?.dispose(cancel);
        },
      };
    },
  };
}
