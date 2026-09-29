/**
 * The standalone `managedVoice` port, shared by the Tauri adapter and the
 * browser-dev harness adapter, which differ only in `invoke`
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

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function createManagedVoicePort(invoke: Invoke): ManagedVoicePort {
  const call = <T>(payload: Record<string, unknown>) => invoke<T>("managed_voice", { payload });
  return {
    offerSetup: import.meta.env.DEV,
    status: () => call<ManagedVoiceStatus>({ op: "status" }),
    configure: async (update) => {
      try {
        return await call<ManagedVoiceConfigResult>({ op: "configure", update });
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
