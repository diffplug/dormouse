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
import type { AlertStateDetail, PtyDataDetail } from "dormouse-lib/lib/platform/types";
import { getTerminalPaneState } from "dormouse-lib/lib/terminal-state-store";
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

// The Burrow lives in the sidecar; this is the webview's end of the bridge
// (lib/src/host/remote/service-protocol.ts). Correlation is `burrowRequestId`, never
// `requestId` — Rust swallows any sidecar line carrying the latter to resolve
// its own pending invokes.
//
// Only what this transport adds is covered here: one invoke carries everything,
// so an answer and a notify ride it as ordinary commands. The correlation,
// timeout, always-answer, and dispose rules are the shared client's
// (lib/src/host/remote/link-client.test.ts).
describe("TauriAdapter remote host link", () => {
  type Payload = { burrowRequestId: string; cmd: string; params?: unknown };

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
        .filter(([cmd]) => cmd === "burrow_command")
        .map(([, args]) => (args as { payload: Payload }).payload);
    const deliver = (event: string, payload: unknown): void => {
      handlers.get(event)?.({ payload });
    };
    return { adapter, sent, deliver };
  }

  it("resolves a command by its burrowRequestId", async () => {
    const { adapter, sent, deliver } = await bridged();
    const pending = adapter.burrow.command("status");

    const payload = sent()[0]!;
    expect(payload.cmd).toBe("status");
    // A result for someone else's burrowRequestId must not resolve this one.
    deliver("burrow:result", { burrowRequestId: "other", result: { enrolled: false } });
    deliver("burrow:result", { burrowRequestId: payload.burrowRequestId, result: { enrolled: true } });

    expect(await pending).toEqual({ enrolled: true });
  });

  it("answers an ask from the registered responder", async () => {
    const { adapter, sent, deliver } = await bridged();
    adapter.burrow.respond("surfaceOp", (params) => [
      { ptyId: "pty-1", ...(params as Record<string, unknown>) },
    ]);

    deliver("burrow:ask", { burrowRequestId: "ask-1", op: "surfaceOp", params: { surfaceId: "s1" } });

    expect(sent()[0]).toMatchObject({
      cmd: "answer",
      params: { burrowRequestId: "ask-1", results: [{ ptyId: "pty-1", surfaceId: "s1" }] },
    });
  });

  it("fans a sidecar event out by name", async () => {
    const { adapter, deliver } = await bridged();
    const seen: unknown[] = [];
    adapter.burrow.on("pairing-queue", (data) => void seen.push(data));

    deliver("burrow:event", { name: "pairing-queue", queue: [{ clientId: "c1" }] });
    expect(seen).toEqual([{ name: "pairing-queue", queue: [{ clientId: "c1" }] }]);
  });

  it("notifies without waiting for anything", async () => {
    const { adapter, sent } = await bridged();
    adapter.burrow.notify();
    expect(sent()[0]).toMatchObject({ cmd: "notify" });
    expect(sent()[0]!.params).toBeUndefined();
  });

  it("rejects what is still in flight when the sidecar is killed", async () => {
    const { adapter } = await bridged();
    const pending = adapter.burrow.command("status");
    adapter.shutdown();
    await expect(pending).rejects.toThrow("burrow bridge closed");
  });
});

// The sidecar owns the parse (docs/specs/terminal-escapes.md → "Parsing
// location"), so this adapter forwards what it is given and never re-derives
// it. What is covered here is exactly that boundary.
describe("TauriAdapter terminal stream", () => {
  async function listening() {
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

    return {
      adapter,
      invoke,
      deliver: (event: string, payload: unknown) => void handlers.get(event)?.({ payload }),
    };
  }

  it("forwards the projection pair it was handed, parsing nothing again", async () => {
    const { adapter, deliver, invoke } = await listening();
    const seen: PtyDataDetail[] = [];
    adapter.onPtyData((detail) => void seen.push(detail));

    // An image sequence: a second parse here would strip nothing but would
    // answer the query below twice.
    deliver("pty:data", {
      id: "t1",
      data: "pre\x1b]1337;File=inline=1:AAAA\x07post",
      textData: "prepost",
    });
    deliver("pty:data", { id: "t1", data: "\x1b]11;?\x07" });

    expect(seen).toEqual([
      { id: "t1", data: "pre\x1b]1337;File=inline=1:AAAA\x07post", textData: "prepost" },
      { id: "t1", data: "\x1b]11;?\x07", textData: undefined },
    ]);
    // No reply written back: the owner answered, or deliberately did not.
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "pty_write")).toEqual([]);
  });

  it("applies the semantic and alert events the sidecar derived", async () => {
    const { adapter, deliver } = await listening();
    const alerts: AlertStateDetail[] = [];
    adapter.onAlertState((detail) => void alerts.push(detail));

    deliver("terminal:semanticEvents", {
      id: "sem-pty",
      events: [
        {
          type: "cwd",
          cwd: {
            path: "/tmp/here",
            pathKind: "posix",
            isRemote: false,
            source: "osc7",
            updatedAt: 1,
          },
        },
      ],
    });
    deliver("terminal:protocolEvents", {
      id: "sem-pty",
      events: [
        { kind: "notification", notification: { source: "OSC 9", title: null, body: "done" } },
      ],
    });

    expect(getTerminalPaneState("sem-pty").cwd?.path).toBe("/tmp/here");
    expect(alerts.some((detail) => detail.id === "sem-pty")).toBe(true);
  });

  it("pushes the resolved theme so the sidecar can answer a colour query", async () => {
    const { adapter, invoke } = await listening();
    adapter.requestInit();

    const pushed = invoke.mock.calls.filter(([cmd]) => cmd === "pty_theme_colors");
    expect(pushed).toHaveLength(1);
    expect(pushed[0]![1]).toEqual({
      colors: {
        foreground: expect.any(String),
        background: expect.any(String),
        cursor: expect.any(String),
      },
    });
  });
});
