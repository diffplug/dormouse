import type { ManagedVoicePort } from './platform/managed-voice-types';
import type { SpeechEngine } from './speech-engine';

/** The slice of `HTMLAudioElement` the engine drives. */
export interface ManagedVoiceAudio {
  onplaying: ((event: Event) => void) | null;
  onended: ((event: Event) => void) | null;
  onerror: ((event: Event | string) => void) | null;
  play(): Promise<void>;
  pause(): void;
  removeAttribute(name: string): void;
  load(): void;
}

export interface ManagedVoicePlayback {
  /** Wrap `audio/mpeg` bytes in a playable URL. */
  url(audio: Uint8Array): string;
  revoke(url: string): void;
  create(url: string): ManagedVoiceAudio;
}

/** Blob URL + `HTMLAudioElement`; the standalone CSP grants `media-src blob:`. */
export const browserPlayback: ManagedVoicePlayback = {
  url: (audio) => URL.createObjectURL(new Blob([audio as BlobPart], { type: 'audio/mpeg' })),
  revoke: (url) => URL.revokeObjectURL(url),
  create: (url) => new Audio(url),
};

/**
 * Host-synthesized audio (`docs/specs/alert.md` -> "Managed voice"): fetch
 * through the port, play, and report `onStart` / `onEnd` from the element's
 * `playing` / `ended`, or `onFail` when nothing was heard. Pair with
 * `withFallback` for the Web Speech fallback.
 */
export function createManagedVoiceEngine(options: {
  port: () => ManagedVoicePort | undefined;
  playback?: ManagedVoicePlayback;
}): SpeechEngine {
  const playback = options.playback ?? browserPlayback;
  return {
    available: () => options.port() !== undefined,
    prepare(input, callbacks) {
      const port = options.port();
      const controller = new AbortController();
      let settled = false;
      let started = false;
      let audio: ManagedVoiceAudio | null = null;
      let url: string | null = null;

      const release = () => {
        if (audio) {
          audio.onplaying = audio.onended = audio.onerror = null;
          try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch { /* already gone */ }
          audio = null;
        }
        if (url) { playback.revoke(url); url = null; }
      };
      const settle = (report: () => void) => {
        if (settled) return;
        settled = true;
        release();
        report();
      };
      const fail = () => settle(callbacks.onFail);

      return {
        start() {
          if (!port) { fail(); return; }
          port.speak(input.text, controller.signal).then((result) => {
            if (settled) return;
            if (!result.ok) { fail(); return; }
            try {
              url = playback.url(result.audio);
              audio = playback.create(url);
            } catch { fail(); return; }
            audio.onplaying = () => { started = true; callbacks.onStart(); };
            audio.onended = () => settle(callbacks.onEnd);
            audio.onerror = () => settle(started ? callbacks.onEnd : callbacks.onFail);
            audio.play().catch(() => { if (!started) fail(); });
          }, fail);
        },
        dispose() {
          settled = true;
          // After the speak settled the port has already dropped its listener,
          // so this reaches the host only mid-request.
          controller.abort();
          release();
        },
      };
    },
  };
}
