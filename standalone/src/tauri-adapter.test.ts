import { describe, expect, it, vi } from "vitest";

// The in-process session-flush handshake and drain wrappers on TauriAdapter are
// pure webview-side logic — they never invoke Tauri — so we only need to stub the
// Tauri modules so the adapter module imports and constructs. Mirrors the mocking
// pattern in updater.test.ts; not a full IPC harness.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn(async () => {}),
}));

import { invoke as rawInvoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { TauriAdapter } from "./tauri-adapter";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("TauriAdapter session-flush handshake", () => {
  it("resolves immediately when no flush handler is registered", async () => {
    const adapter = new TauriAdapter();
    await adapter.requestSessionFlush(50);
  });

  it("fans a requestId out to handlers and resolves on completion", async () => {
    const adapter = new TauriAdapter();
    let seenRequestId: string | null = null;
    const handler = (detail: { requestId: string }) => {
      seenRequestId = detail.requestId;
    };
    adapter.onRequestSessionFlush(handler);

    let resolved = false;
    void adapter.requestSessionFlush(1000).then(() => {
      resolved = true;
    });
    await tick();
    expect(seenRequestId).not.toBeNull();
    expect(resolved).toBe(false); // waits for completion

    adapter.notifySessionFlushComplete(seenRequestId!);
    await tick();
    expect(resolved).toBe(true);
    // A repeat notify (or an unknown requestId) is a harmless no-op.
    expect(() => adapter.notifySessionFlushComplete(seenRequestId!)).not.toThrow();
    expect(() => adapter.notifySessionFlushComplete("bogus")).not.toThrow();
  });

  it("resolves on timeout when a handler never completes", async () => {
    const adapter = new TauriAdapter();
    adapter.onRequestSessionFlush(() => {
      /* never calls notifySessionFlushComplete */
    });

    let resolved = false;
    void adapter.requestSessionFlush(10).then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(resolved).toBe(true);
  });

  it("stops fanning out to a removed handler", async () => {
    const adapter = new TauriAdapter();
    const removed = vi.fn();
    const kept = (detail: { requestId: string }) => {
      adapter.notifySessionFlushComplete(detail.requestId);
    };
    adapter.onRequestSessionFlush(removed);
    adapter.onRequestSessionFlush(kept);
    adapter.offRequestSessionFlush(removed);

    await adapter.requestSessionFlush(1000);
    expect(removed).not.toHaveBeenCalled();
  });

  it("drainSessionSaves resolves immediately when the store pipeline is idle", async () => {
    const adapter = new TauriAdapter();
    await adapter.drainSessionSaves(1000);
  });
});

describe("TauriAdapter legacy session cleanup", () => {
  it("asks Rust to clear orphaned temp state when no main snapshot exists", async () => {
    const invoke = vi.mocked(rawInvoke);
    invoke.mockClear();
    invoke.mockResolvedValue(undefined);
    const adapter = new TauriAdapter();

    await adapter.init();

    expect(invoke).toHaveBeenNthCalledWith(1, "load_session");
    expect(invoke).toHaveBeenNthCalledWith(2, "clear_session");
    adapter.shutdown();
  });
});

// The remote Host lives in the sidecar; this is the webview's end of the bridge
// (lib/src/host/remote/service-protocol.ts). Correlation is `rhId`, never
// `requestId` — Rust swallows any sidecar line carrying the latter to resolve
// its own pending invokes.
describe("TauriAdapter remote host link", () => {
  type Payload = { rhId: string; cmd: string; params?: unknown };

  async function bridged() {
    const handlers = new Map<string, (event: { payload: unknown }) => void>();
    vi.mocked(listen).mockImplementation((async (
      event: string,
      handler: (e: { payload: unknown }) => void,
    ) => {
      handlers.set(event, handler);
      return () => {};
    }) as unknown as typeof listen);
    const invoke = vi.mocked(rawInvoke);
    invoke.mockClear();
    invoke.mockResolvedValue(undefined);

    const adapter = new TauriAdapter();
    await adapter.init();
    invoke.mockClear();

    const sent = (): Payload[] =>
      invoke.mock.calls
        .filter(([cmd]) => cmd === "remote_host_command")
        .map(([, args]) => (args as { payload: Payload }).payload);
    const deliver = (event: string, payload: unknown): void => {
      handlers.get(event)?.({ payload });
    };
    return { adapter, sent, deliver };
  }

  it("resolves a command by its rhId", async () => {
    const { adapter, sent, deliver } = await bridged();
    const pending = adapter.remoteHost.command("status");

    const payload = sent()[0]!;
    expect(payload.cmd).toBe("status");
    // A result for someone else's rhId must not resolve this one.
    deliver("remoteHost:result", { rhId: "other", result: { enrolled: false } });
    deliver("remoteHost:result", { rhId: payload.rhId, result: { enrolled: true } });

    expect(await pending).toEqual({ enrolled: true });
  });

  it("rejects with the error the service reported", async () => {
    const { adapter, sent, deliver } = await bridged();
    const pending = adapter.remoteHost.command("enroll", { serverUrl: "https://nope" });
    deliver("remoteHost:result", { rhId: sent()[0]!.rhId, error: "outside the allowed sources" });
    await expect(pending).rejects.toThrow("outside the allowed sources");
  });

  it("rejects when the sidecar never answers", async () => {
    const { adapter, deliver } = await bridged();
    vi.useFakeTimers();
    try {
      const pending = adapter.remoteHost.command("status");
      const rejected = expect(pending).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(20_000);
      await rejected;
      // The late answer finds nothing to settle.
      expect(() => deliver("remoteHost:result", { rhId: "rh-1", result: {} })).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers an ask from the registered responder", async () => {
    const { adapter, sent, deliver } = await bridged();
    adapter.remoteHost.respond("surfaceOp", (params) => [
      { ptyId: "pty-1", ...(params as Record<string, unknown>) },
    ]);

    deliver("remoteHost:ask", { rhId: "ask-1", op: "surfaceOp", params: { surfaceId: "s1" } });

    expect(sent()[0]).toMatchObject({
      cmd: "answer",
      params: { rhId: "ask-1", results: [{ ptyId: "pty-1", surfaceId: "s1" }] },
    });
  });

  it("answers with nothing rather than leaving an ask open", async () => {
    const { adapter, sent, deliver } = await bridged();
    // Nobody responds to this op, and a handler that throws is the same case:
    // the service would otherwise hold the ask for its whole budget.
    deliver("remoteHost:ask", { rhId: "ask-1", op: "directory", params: {} });
    adapter.remoteHost.respond("directory", () => {
      throw new Error("registry blew up");
    });
    deliver("remoteHost:ask", { rhId: "ask-2", op: "directory", params: {} });

    expect(sent().map((p) => p.params)).toEqual([
      { rhId: "ask-1", results: [] },
      { rhId: "ask-2", results: [] },
    ]);
  });

  it("fans events out by name, and stops after unsubscribe", async () => {
    const { adapter, deliver } = await bridged();
    const seen: unknown[] = [];
    const unsubscribe = adapter.remoteHost.on("pairing-queue", (data) => void seen.push(data));

    deliver("remoteHost:event", { name: "pairing-queue", queue: [{ clientId: "c1" }] });
    deliver("remoteHost:event", { name: "something-else", queue: [] });
    expect(seen).toEqual([{ name: "pairing-queue", queue: [{ clientId: "c1" }] }]);

    unsubscribe();
    deliver("remoteHost:event", { name: "pairing-queue", queue: [] });
    expect(seen).toHaveLength(1);
  });

  it("notifies without waiting for anything", async () => {
    const { adapter, sent } = await bridged();
    adapter.remoteHost.notify("directory");
    expect(sent()[0]).toMatchObject({ cmd: "notify", params: { topic: "directory" } });
  });

  it("rejects what is still in flight when the bridge closes", async () => {
    const { adapter } = await bridged();
    const pending = adapter.remoteHost.command("status");
    adapter.shutdown();
    await expect(pending).rejects.toThrow("remote host bridge closed");
  });
});
