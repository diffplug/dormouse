import { getPlatform } from './platform';
import type { ManagedVoicePort } from './platform/managed-voice-types';
import type { SpeechAttemptHandle, SpeechEngine } from './speech-engine';

/** The slice of `HTMLAudioElement` the engine drives. */
export interface ManagedVoiceAudio {
  onplaying: ((event: Event) => void) | null;
  onended: ((event: Event) => void) | null;
  onerror: ((event: Event | string) => void) | null;
  play(): Promise<void>;
  pause(): void;
}

export interface ManagedVoicePlayback {
  /** Wrap the bytes in a playable URL. */
  url(audio: Uint8Array, mime: string): string;
  revoke(url: string): void;
  create(url: string): ManagedVoiceAudio;
}

/** Blob URL + `HTMLAudioElement`; the standalone CSP grants `media-src blob:`. */
export const browserPlayback: ManagedVoicePlayback = {
  url: (audio, mime) => URL.createObjectURL(new Blob([audio as BlobPart], { type: mime })),
  revoke: (url) => URL.revokeObjectURL(url),
  create: (url) => new Audio(url),
};

/** The installed adapter's managed-voice port, if the host has one. */
export function currentManagedVoicePort(): ManagedVoicePort | undefined {
  try {
    return getPlatform().managedVoice;
  } catch {
    return undefined;
  }
}

/**
 * Managed voice first, Web Speech as the per-utterance fallback
 * (`docs/specs/alert.md` -> "Spoken alarms"). With no port this is exactly the
 * fallback engine. With one, the text goes to the host, which answers with audio
 * or a failure kind; any failure *before audio starts* speaks the same input
 * through the fallback within the same attempt. Audio that started and then
 * failed ends the attempt instead — **never play both**.
 *
 * `onStart` / `onEnd` follow the audio element's `playing` / `ended`, so the
 * queue's `speaking` / `spoken` track real playback. `dispose(true)` aborts the
 * in-flight request (the adapter carries that to the host) and silences audio.
 */
export function createManagedVoiceEngine(options: {
  port: () => ManagedVoicePort | undefined;
  fallback: SpeechEngine;
  playback?: ManagedVoicePlayback;
}): SpeechEngine {
  const { fallback } = options;
  const playback = options.playback ?? browserPlayback;
  return {
    available: () => fallback.available() || options.port() !== undefined,
    prepare(input, callbacks): SpeechAttemptHandle {
      const port = options.port();
      if (!port) return fallback.prepare(input, callbacks);

      let phase: 'idle' | 'fetching' | 'playing' | 'fallback' | 'done' = 'idle';
      let started = false;
      let audio: ManagedVoiceAudio | null = null;
      let url: string | null = null;
      let fallbackHandle: SpeechAttemptHandle | null = null;
      const controller = new AbortController();

      const releaseAudio = () => {
        if (audio) {
          audio.onplaying = audio.onended = audio.onerror = null;
          try { audio.pause(); } catch { /* already gone */ }
          audio = null;
        }
        if (url) { playback.revoke(url); url = null; }
      };
      const end = () => {
        phase = 'done';
        releaseAudio();
        callbacks.onEnd();
      };
      // Only before any managed audio was heard; the fallback reports through
      // the same callbacks, so the queue sees one attempt either way.
      const fallBack = () => {
        releaseAudio();
        if (started || !fallback.available()) { end(); return; }
        phase = 'fallback';
        try {
          fallbackHandle = fallback.prepare(input, callbacks);
          fallbackHandle.start();
        } catch {
          if (phase === 'fallback') end();
        }
      };
      const play = (bytes: Uint8Array, mime: string) => {
        try {
          url = playback.url(bytes, mime);
          audio = playback.create(url);
        } catch { fallBack(); return; }
        phase = 'playing';
        const element = audio;
        element.onplaying = () => {
          if (phase !== 'playing' || started) return;
          started = true;
          callbacks.onStart();
        };
        element.onended = () => { if (phase === 'playing') end(); };
        element.onerror = () => { if (phase === 'playing') { if (started) end(); else fallBack(); } };
        element.play().catch(() => { if (phase === 'playing' && !started) fallBack(); });
      };

      return {
        start() {
          phase = 'fetching';
          port.speak(input.text, controller.signal).then(
            (result) => {
              if (phase !== 'fetching') return;
              if (result.ok) play(result.audio, result.mime);
              else fallBack();
            },
            () => { if (phase === 'fetching') fallBack(); },
          );
        },
        dispose(cancel) {
          const was = phase;
          phase = 'done';
          if (was === 'fetching') controller.abort();
          releaseAudio();
          fallbackHandle?.dispose(cancel);
        },
      };
    },
  };
}
