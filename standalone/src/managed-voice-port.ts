/**
 * The standalone `managedVoice` port, shared by the Tauri adapter and the
 * browser-dev harness adapter, which differ only in `invoke` and in how the
 * `voice:status` broadcast reaches `receiveStatus`
 * (`docs/specs/transport.md` -> "Managed voice").
 */
import { bakedRelayMode } from "dormouse-lib/host/relay-origin";
import {
  createManagedVoicePortClient,
  type ManagedVoicePortClient,
} from "dormouse-lib/lib/platform/managed-voice-port";

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * This build's port: none in a self-host build, whose Settings then hide the
 * section and whose alerts speak through Web Speech alone
 * (`docs/specs/alert.md` -> "Managed voice").
 */
export function managedVoicePortForBuild(invoke: Invoke): ManagedVoicePortClient | undefined {
  return bakedRelayMode() === "hosted" ? createManagedVoicePort(invoke) : undefined;
}

/** The port over Tauri's `managed_voice` command. */
export function createManagedVoicePort(invoke: Invoke): ManagedVoicePortClient {
  return createManagedVoicePortClient((payload) => invoke("managed_voice", { payload }));
}
