/**
 * The webview half of the `managedVoice` port (`docs/specs/transport.md` ->
 * "Managed voice"), over whatever carries a `voice:command` payload to its host
 * and back: Tauri's `invoke`, or VS Code's webview messages. Each host's
 * adapter feeds its `voice:status` broadcasts to `receiveStatus`.
 */
import { messageOf } from '../errors';
import type {
  ManagedVoiceConfigResult,
  ManagedVoiceHostSpeakResult,
  ManagedVoicePort,
  ManagedVoiceStatus,
} from './managed-voice-types';

/** Send one `voice:command` payload; answers the host's result, or `null` for a host error. */
export type SendVoiceCommand = (payload: Record<string, unknown>) => Promise<unknown>;

export interface ManagedVoicePortClient extends ManagedVoicePort {
  /** A `voice:status` broadcast. */
  receiveStatus(data: unknown): void;
  /** Ask the host for its status; call once the `voice:status` listener is live. */
  refresh(): void;
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function createManagedVoicePortClient(send: SendVoiceCommand): ManagedVoicePortClient {
  const call = <T>(payload: Record<string, unknown>) => send(payload) as Promise<T>;
  let status: ManagedVoiceStatus | null = null;
  const listeners = new Set<() => void>();
  // Invoke answers and broadcasts ride separate channels: an answer is applied
  // only if no broadcast, which is newer, arrived after its request was sent.
  let broadcasts = 0;

  const apply = (data: unknown): void => {
    const next = data as Partial<ManagedVoiceStatus> | null;
    if (typeof next?.configured !== 'boolean' || typeof next.voiceId !== 'string') return;
    status = { configured: next.configured, voiceId: next.voiceId, notEntitled: next.notEntitled === true };
    for (const listener of listeners) listener();
  };
  const ask = async <T>(payload: Record<string, unknown>): Promise<T> => {
    const sent = broadcasts;
    const result = await call<T>(payload);
    if (broadcasts === sent) apply(result);
    return result;
  };

  return {
    status: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    receiveStatus(data) {
      broadcasts++;
      apply(data);
    },
    refresh() {
      ask({ op: 'status' }).catch(() => {});
    },
    configure: async (update) => {
      try {
        // Null when the host answered with an error, or not in time.
        return (await ask<ManagedVoiceConfigResult | null>({ op: 'configure', update }))
          ?? { ok: false, reason: 'unavailable' };
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
    },
    speak: async (text) => {
      try {
        const result = await call<ManagedVoiceHostSpeakResult | null>({ op: 'speak', text });
        if (!result?.ok) return { ok: false, reason: result?.reason ?? 'unavailable' };
        return { ok: true, audio: decodeBase64(result.audioBase64) };
      } catch (err) {
        return { ok: false, reason: messageOf(err) };
      }
    },
  };
}
