/**
 * Managed voice shapes shared by the webview and the Node host module
 * (`docs/specs/transport.md` -> "Managed voice"). Dependency-free so
 * `lib/src/host/` can import it without the browser-typed `platform/types` graph.
 */

/** ElevenLabs premade "Rachel"; the Settings voice id field may override it. */
export const DEFAULT_MANAGED_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

export interface ManagedVoiceStatus {
  /**
   * `false` in a self-host build, which sends nothing to Hosted: the Settings
   * group hides and nothing is spoken through it (`docs/specs/alert.md` ->
   * "Managed voice").
   */
  available: boolean;
  configured: boolean;
  voiceId: string;
}

/** `token: null` clears it; an absent key leaves that field alone. */
export interface ManagedVoiceConfigUpdate {
  token?: string | null;
  voiceId?: string;
}

export type ManagedVoiceConfigResult =
  | ({ ok: true } & ManagedVoiceStatus)
  | { ok: false; reason: 'invalid-token' | 'invalid-voice' | 'unavailable' };

/** The host's `speak` answer on the wire: `audio/mpeg` as base64. */
export type ManagedVoiceHostSpeakResult =
  | { ok: true; audioBase64: string }
  | { ok: false; reason: string };

/** Audio is always `audio/mpeg`. `reason` is diagnostic only; nothing branches on it. */
export type ManagedVoiceSpeakResult =
  | { ok: true; audio: Uint8Array }
  | { ok: false; reason: string };

export interface ManagedVoicePort {
  /** Show the Settings setup even with no token saved (dev builds). */
  offerSetup: boolean;
  /** The host's last broadcast status; `null` until the first arrives. */
  status(): ManagedVoiceStatus | null;
  /** Called after every change to `status()`. */
  subscribe(listener: () => void): () => void;
  configure(update: ManagedVoiceConfigUpdate): Promise<ManagedVoiceConfigResult>;
  /** Never rejects: every failure is an `ok: false` answer. */
  speak(text: string): Promise<ManagedVoiceSpeakResult>;
}
