/**
 * Managed voice shapes shared by the webview and the Node host module
 * (`docs/specs/transport.md` -> "Managed voice"). Free of the browser-typed
 * `platform/types` graph so `lib/src/host/` can import it; the curated voice
 * set is `remote-lib-common`'s, which the voice Worker checks against too.
 */

import type { HostedEnrollmentState } from '../../host/remote/service-protocol';

export { DEFAULT_MANAGED_VOICE_ID, MANAGED_VOICES } from 'remote-lib-common';

/**
 * The host's bound on one speak request (`docs/specs/alert.md` -> "Managed
 * voice"). Each bridge waits longer, so the host's answer arrives first: Rust's
 * `MANAGED_VOICE_TIMEOUT`, and VS Code's webview command timeout.
 */
export const MANAGED_VOICE_REQUEST_TIMEOUT_MS = 15_000;

/** Natural Voice's approval: the same shape as remote control's, from the same run. */
export type ManagedVoiceEnrollment = HostedEnrollmentState;

export type ManagedVoiceActionResult = { ok: true } | { ok: false; message: string };

export interface ManagedVoiceStatus {
  enrollment?: ManagedVoiceEnrollment | null;
  /** Voice is off in memory, but clearing its saved credential needs a retry. */
  disconnectFailed?: boolean;
  /** A voice token is held after explicit managed-voice approval. */
  configured: boolean;
  /** The member default, always one of `MANAGED_VOICES`. */
  voiceId: string;
  /**
   * Hosted refused the held token as not entitled (403), and nothing has
   * spoken since. Memory only: a restart learns it again at the next speak.
   */
  notEntitled: boolean;
}

/**
 * What the webview may change: the default voice. **Never the token**, which
 * only managed-voice approval writes and its disconnect clears.
 */
export interface ManagedVoiceConfigUpdate {
  voiceId: string;
}

export type ManagedVoiceConfigResult =
  | ({ ok: true } & ManagedVoiceStatus)
  | { ok: false; reason: 'invalid-voice' | 'unavailable' };

/** The host's `speak` answer on the wire: `audio/mpeg` as base64. */
export type ManagedVoiceHostSpeakResult =
  | { ok: true; audioBase64: string }
  | { ok: false; reason: string };

/** Audio is always `audio/mpeg`. `reason` is diagnostic only; nothing branches on it. */
export type ManagedVoiceSpeakResult =
  | { ok: true; audio: Uint8Array }
  | { ok: false; reason: string };

export interface ManagedVoicePort {
  /** The host's last broadcast status; `null` until the first arrives. */
  status(): ManagedVoiceStatus | null;
  /** Called after every change to `status()`. */
  subscribe(listener: () => void): () => void;
  beginEnrollment(): Promise<ManagedVoiceActionResult>;
  cancelEnrollment(): Promise<ManagedVoiceActionResult>;
  disconnect(): Promise<ManagedVoiceActionResult>;
  configure(update: ManagedVoiceConfigUpdate): Promise<ManagedVoiceConfigResult>;
  /** Never rejects: every failure is an `ok: false` answer. */
  speak(text: string): Promise<ManagedVoiceSpeakResult>;
}
