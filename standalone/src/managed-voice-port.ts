/**
 * The standalone `managedVoice` port, shared by the Tauri adapter and the
 * browser-dev harness adapter; only the transport differs
 * (`docs/specs/transport.md` -> "Managed voice").
 */
import type {
  ManagedVoiceConfigResult,
  ManagedVoicePort,
  ManagedVoiceStatus,
} from "dormouse-lib/lib/platform/managed-voice-types";

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export function createManagedVoicePort(options: {
  invoke: Invoke;
  /** `managed_voice_speak`'s resolved value to `audio/mpeg` bytes. */
  decodeSpeak: (raw: unknown) => Uint8Array;
  offerSetup: boolean;
}): ManagedVoicePort {
  const { invoke, decodeSpeak } = options;
  const command = <T>(payload: Record<string, unknown>) => invoke<T>("managed_voice_command", { payload });
  return {
    offerSetup: options.offerSetup,
    status: () => command<ManagedVoiceStatus>({ op: "status" }),
    configure: async (update) => {
      try {
        return await command<ManagedVoiceConfigResult>({ op: "configure", update });
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },
    speak: async (text, signal) => {
      if (signal.aborted) return { ok: false, reason: "cancelled" };
      const speakId = crypto.randomUUID();
      const cancel = () => { command({ op: "cancel", speakId }).catch(() => {}); };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        return { ok: true, audio: decodeSpeak(await invoke<unknown>("managed_voice_speak", { text, speakId })) };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    },
  };
}
