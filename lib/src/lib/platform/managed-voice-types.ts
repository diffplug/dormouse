/**
 * Managed voice shapes shared by the webview and the Node host module
 * (`docs/specs/alert.md` -> "Managed voice"). Dependency-free so
 * `lib/src/host/` can import it without the browser-typed `platform/types` graph.
 */

export const MANAGED_VOICE_ORIGIN = 'https://hosted.dormouse.sh';
export const MANAGED_VOICE_SPEAK_PATH = '/api/voice/speak';

/** Host request ceiling, inside `SPEECH_ENGINE_TIMEOUT_MS` so a fallback still fits.
 *  Rust's bridge keeps its own `MANAGED_VOICE_SPEAK_TIMEOUT` above it. */
export const MANAGED_VOICE_REQUEST_TIMEOUT_MS = 15_000;

/** ElevenLabs premade "Rachel"; the Settings voice id field may override it. */
export const DEFAULT_MANAGED_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

/** Hosted's own `voiceId` grammar, checked before anything is stored or sent. */
export const MANAGED_VOICE_ID_PATTERN = /^[A-Za-z0-9]{1,64}$/;

/** `dmv_` + base64url of 32 random bytes, unpadded. */
export const MANAGED_VOICE_TOKEN_PATTERN = /^dmv_[A-Za-z0-9_-]{43}$/;

export interface ManagedVoiceStatus {
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

/** Audio is always `audio/mpeg`. `reason` is diagnostic only; nothing branches on it. */
export type ManagedVoiceSpeakResult =
  | { ok: true; audio: Uint8Array }
  | { ok: false; reason: string };

/** Aborting `signal` aborts the host's in-flight request. */
export interface ManagedVoicePort {
  /** Show the Settings setup even with no token saved (dev builds). */
  offerSetup: boolean;
  status(): Promise<ManagedVoiceStatus>;
  configure(update: ManagedVoiceConfigUpdate): Promise<ManagedVoiceConfigResult>;
  speak(text: string, signal: AbortSignal): Promise<ManagedVoiceSpeakResult>;
}
