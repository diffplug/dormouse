/**
 * A stand-in for Web Speech, shared by the suites that drive speech
 * (`alert-speech.test.ts`, `alert-delivery.test.ts`, the Settings tests).
 * `vi.unstubAllGlobals()` removes it.
 */
import { vi } from 'vitest';

/** What `SpeechQueue` sets on an utterance before handing it to the engine. */
export interface StubUtterance {
  text: string;
  voice: unknown;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

/** The stubbed engine's record, updated as it is driven. */
export interface SpeechSynthesisStub {
  /** Each utterance's text, in the order `speak` received it. */
  spoken: string[];
  utterances: StubUtterance[];
  /** Calls to `cancel`. */
  cancels: number;
  /** Extra engine behavior a single test wants from `speak`. */
  onSpeak: ((utterance: StubUtterance) => void) | null;
}

/** Stub `speechSynthesis` and `SpeechSynthesisUtterance`, offering `voices`. */
export function stubSpeechSynthesis(voices: readonly unknown[] = []): SpeechSynthesisStub {
  const engine: SpeechSynthesisStub = { spoken: [], utterances: [], cancels: 0, onSpeak: null };
  vi.stubGlobal('speechSynthesis', {
    getVoices: () => [...voices],
    speak: (utterance: StubUtterance) => {
      engine.spoken.push(utterance.text);
      engine.utterances.push(utterance);
      engine.onSpeak?.(utterance);
    },
    cancel: () => {
      engine.cancels += 1;
    },
  });
  vi.stubGlobal('SpeechSynthesisUtterance', class implements StubUtterance {
    voice: unknown = null;
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public text: string) {}
  });
  return engine;
}
