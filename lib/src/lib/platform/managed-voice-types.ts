/**
 * Managed voice: spoken alarms synthesized by Hosted instead of the local Web
 * Speech engine (`docs/specs/alert.md` -> "Spoken alarms"). The token lives in
 * the host process and never crosses into a renderer: every shape below that
 * travels host → webview carries `configured`, never the token.
 *
 * Kept in its own dependency-free file so the Node host module in
 * `lib/src/host/` can share it without the browser-typed `platform/types` graph.
 */

/** The only endpoint a managed-voice host calls. */
export const MANAGED_VOICE_SPEAK_URL = 'https://hosted.dormouse.sh/api/voice/speak';

/** ElevenLabs premade "Rachel"; the Settings voice id field may override it. */
export const DEFAULT_MANAGED_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

/** Hosted's own `voiceId` grammar, checked before anything is stored or sent. */
export const MANAGED_VOICE_ID_PATTERN = /^[A-Za-z0-9]{1,64}$/;

/** `dmv_` + base64url of 32 random bytes, unpadded. */
export const MANAGED_VOICE_TOKEN_PATTERN = /^dmv_[A-Za-z0-9_-]{43}$/;

/** What the webview may learn about the host's managed-voice configuration. */
export interface ManagedVoiceStatus {
  configured: boolean;
  voiceId: string;
}

/**
 * One edit to the host's configuration. `token: null` clears it; an absent key
 * leaves that field alone. Invalid values are refused, never stored.
 */
export interface ManagedVoiceConfigUpdate {
  token?: string | null;
  voiceId?: string;
}

export type ManagedVoiceConfigResult =
  | ({ ok: true } & ManagedVoiceStatus)
  | { ok: false; reason: 'invalid-token' | 'invalid-voice' | 'unavailable' };

/**
 * Why one synthesis produced no audio. Every kind falls back to Web Speech for
 * that utterance; none is retried.
 */
export type ManagedVoiceFailure =
  | 'unconfigured'
  | 'bad-request'
  | 'unauthorized'
  | 'forbidden'
  | 'rate-limited'
  | 'upstream'
  | 'http'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'unavailable';

export const MANAGED_VOICE_FAILURES: readonly ManagedVoiceFailure[] = [
  'unconfigured', 'bad-request', 'unauthorized', 'forbidden', 'rate-limited',
  'upstream', 'http', 'network', 'timeout', 'cancelled', 'unavailable',
];

export type ManagedVoiceSpeakResult =
  | { ok: true; audio: Uint8Array; mime: string }
  | { ok: false; reason: ManagedVoiceFailure };

/**
 * The adapter member a host with a managed-voice backend exposes. `speak` sends
 * only the text; the host adds its stored voice id and token. Aborting `signal`
 * must abort the host's in-flight request, and the promise then resolves
 * `cancelled`.
 */
export interface ManagedVoicePort {
  status(): Promise<ManagedVoiceStatus>;
  configure(update: ManagedVoiceConfigUpdate): Promise<ManagedVoiceConfigResult>;
  speak(text: string, signal: AbortSignal): Promise<ManagedVoiceSpeakResult>;
}

/** Map a host's error string back to a failure kind; anything unknown is `unavailable`. */
export function toManagedVoiceFailure(value: unknown): ManagedVoiceFailure {
  return MANAGED_VOICE_FAILURES.includes(value as ManagedVoiceFailure)
    ? value as ManagedVoiceFailure
    : 'unavailable';
}
