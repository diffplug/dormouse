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
    // A port whose host has no token is unavailable, so `withFallback` goes
    // straight to Web Speech; an `unconfigured` answer still falls back.
    available: () => options.port()?.status()?.configured === true,
    prepare(input, callbacks) {
      // Only ever after `available()`, in the same call stack.
      const port = options.port()!;
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
      const stop = () => settle(started ? callbacks.onEnd : callbacks.onFail);

      return {
        start() {
          // A request still in flight at `dispose` runs out in the host; its
          // answer finds the attempt settled.
          void port.speak(input.text).then((result) => {
            if (settled) return;
            if (!result.ok) { fail(); return; }
            try {
              url = playback.url(result.audio);
              audio = playback.create(url);
            } catch { fail(); return; }
            audio.onplaying = () => { started = true; callbacks.onStart(); };
            audio.onended = () => settle(callbacks.onEnd);
            audio.onerror = stop;
            audio.play().catch(stop);
          });
        },
        dispose() {
          settled = true;
          release();
        },
      };
    },
  };
}
