/**
 * The standalone `managedVoice` port, shared by the Tauri adapter and the
 * browser-dev harness adapter, which differ only in `invoke` and in how the
 * `voice:status` broadcast reaches `receiveStatus`
 * (`docs/specs/transport.md` -> "Managed voice").
 */
import { messageOf } from "dormouse-lib/lib/errors";
import type {
  ManagedVoiceConfigResult,
  ManagedVoiceHostSpeakResult,
  ManagedVoicePort,
  ManagedVoiceStatus,
} from "dormouse-lib/lib/platform/managed-voice-types";

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export interface StandaloneManagedVoicePort extends ManagedVoicePort {
  /** A `voice:status` broadcast, or a `status` answer. */
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

export function createManagedVoicePort(invoke: Invoke): StandaloneManagedVoicePort {
  const call = <T>(payload: Record<string, unknown>) => invoke<T>("managed_voice", { payload });
  let status: ManagedVoiceStatus | null = null;
  const listeners = new Set<() => void>();

  const receiveStatus = (data: unknown): void => {
    const next = data as Partial<ManagedVoiceStatus> | null;
    if (typeof next?.configured !== "boolean" || typeof next.voiceId !== "string") return;
    status = { configured: next.configured, voiceId: next.voiceId };
    for (const listener of listeners) listener();
  };

  return {
    offerSetup: import.meta.env.DEV,
    status: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    receiveStatus,
    refresh() {
      call<unknown>({ op: "status" }).then(receiveStatus, () => {});
    },
    configure: async (update) => {
      try {
        const result = await call<ManagedVoiceConfigResult>({ op: "configure", update });
        if (result.ok) receiveStatus(result);
        return result;
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },
    speak: async (text) => {
      try {
        const result = await call<ManagedVoiceHostSpeakResult | null>({ op: "speak", text });
        if (!result?.ok) return { ok: false, reason: result?.reason ?? "unavailable" };
        return { ok: true, audio: decodeBase64(result.audioBase64) };
      } catch (err) {
        return { ok: false, reason: messageOf(err) };
      }
    },
  };
}
