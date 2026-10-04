import { describe, expect, it, vi } from "vitest";
import { createManagedVoicePort } from "./managed-voice-port";

/** An `invoke` that answers `managed_voice` from `answer`, recording each payload. */
function harness(answer: (payload: Record<string, unknown>) => unknown) {
  const payloads: Array<Record<string, unknown>> = [];
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    expect(cmd).toBe("managed_voice");
    const payload = args?.payload as Record<string, unknown>;
    payloads.push(payload);
    return answer(payload);
  }) as unknown as <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  return { port: createManagedVoicePort(invoke), payloads };
}

describe("createManagedVoicePort", () => {
  it("caches the status it is asked for, then each broadcast, and tells its subscribers", async () => {
    const { port } = harness(() => ({ configured: true, voiceId: "v1" }));
    const heard = vi.fn();
    port.subscribe(heard);
    expect(port.status()).toBeNull();

    port.refresh();
    await vi.waitFor(() => expect(port.status()).toEqual({ configured: true, voiceId: "v1", notEntitled: false }));
    port.receiveStatus({ configured: false, voiceId: "v2", notEntitled: true });
    expect(port.status()).toEqual({ configured: false, voiceId: "v2", notEntitled: true });
    // Not a status: ignored, never cached.
    port.receiveStatus({ configured: "yes" });
    expect(port.status()).toEqual({ configured: false, voiceId: "v2", notEntitled: true });
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("caches a saved edit's status without waiting for the broadcast", async () => {
    const { port } = harness(() => ({ ok: true, configured: true, voiceId: "v1", notEntitled: false }));
    expect(await port.configure({ voiceId: "v1" })).toEqual({ ok: true, configured: true, voiceId: "v1", notEntitled: false });
    expect(port.status()).toEqual({ configured: true, voiceId: "v1", notEntitled: false });
  });

  it.each([
    ["status", (port: ReturnType<typeof createManagedVoicePort>) => { port.refresh(); }],
    ["configure", (port: ReturnType<typeof createManagedVoicePort>) => { void port.configure({ voiceId: "v1" }); }],
  ])("keeps a broadcast that overtook the %s answer requested before it", async (_op, ask) => {
    let answer!: (value: unknown) => void;
    const { port } = harness(() => new Promise((resolve) => { answer = resolve; }));
    ask(port);
    // This computer signed in: the broadcast lands before this older answer.
    port.receiveStatus({ configured: true, voiceId: "v2", notEntitled: false });
    answer({ ok: true, configured: false, voiceId: "v1", notEntitled: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(port.status()).toEqual({ configured: true, voiceId: "v2", notEntitled: false });
  });

  it("reports a configure the sidecar failed as unavailable", async () => {
    const { port } = harness(() => null);
    expect(await port.configure({ voiceId: "v1" })).toEqual({ ok: false, reason: "unavailable" });
  });

  it("decodes the host's base64 audio once", async () => {
    const { port, payloads } = harness(() => ({ ok: true, audioBase64: btoa("\x01\x02\xff") }));
    expect(await port.speak("build finished")).toEqual({ ok: true, audio: new Uint8Array([1, 2, 255]) });
    expect(payloads).toEqual([{ op: "speak", text: "build finished" }]);
  });

  it.each([
    ["a refusal", () => ({ ok: false, reason: "HTTP 429" }), "HTTP 429"],
    ["a sidecar error", () => null, "unavailable"],
    ["a bridge failure", () => { throw new Error("timed out waiting for voice:command"); }, "timed out waiting for voice:command"],
  ])("answers %s as a failure, never a rejection", async (_label, answer, reason) => {
    const { port } = harness(answer);
    expect(await port.speak("x")).toEqual({ ok: false, reason });
  });
});
