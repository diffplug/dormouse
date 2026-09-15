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
import type { NotepadArchiveV1 } from "dormouse-lib/lib/notepad/types";
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

describe("TauriAdapter cwd probing", () => {
  it("sends one pty_get_cwds for the Workspaces saving together", async () => {
    // Every Wall answers the quit flush with its own `getCwds`; uncoalesced,
    // N Workspaces cost N sidecar round trips and N `lsof` spawns inside them.
    const adapter = new TauriAdapter();
    vi.mocked(rawInvoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd !== "pty_get_cwds") return undefined;
      const ids = (args as { ids: string[] }).ids;
      return Object.fromEntries(ids.map((id) => [id, `/cwd/${id}`]));
    });

    const [a, b] = await Promise.all([adapter.getCwds(["pane-a"]), adapter.getCwds(["pane-b"])]);

    const cwdCalls = vi.mocked(rawInvoke).mock.calls.filter(([cmd]) => cmd === "pty_get_cwds");
    expect(cwdCalls).toHaveLength(1);
    expect(cwdCalls[0][1]).toEqual({ ids: ["pane-a", "pane-b"] });
    expect(a).toEqual({ "pane-a": "/cwd/pane-a" });
    expect(b).toEqual({ "pane-b": "/cwd/pane-b" });
  });
});

describe("TauriAdapter port probing", () => {
  it("sends one pty_get_open_ports_many for a whole listing, and fails soft", async () => {
    // `dor list --ports` across Workspaces asks once for every terminal: the
    // sidecar's scan is synchronous, so one call is one pass over the process
    // and socket tables instead of one per terminal.
    const adapter = new TauriAdapter();
    const port = (value: number) => ({ family: "IPv4", address: "127.0.0.1", port: value, pid: 1 });
    vi.mocked(rawInvoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd !== "pty_get_open_ports_many") return undefined;
      const ids = (args as { ids: string[] }).ids;
      return Object.fromEntries(ids.map((id, index) => [id, [port(5000 + index)]]));
    });

    expect(await adapter.getOpenPortsMany(["pane-a", "pane-b"])).toEqual({
      "pane-a": [port(5000)],
      "pane-b": [port(5001)],
    });
    const calls = vi.mocked(rawInvoke).mock.calls.filter(([cmd]) => cmd === "pty_get_open_ports_many");
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({ ids: ["pane-a", "pane-b"] });

    // A failed scan is no ports, never a rejected listing.
    vi.mocked(rawInvoke).mockRejectedValueOnce(new Error("sidecar is gone"));
    expect(await adapter.getOpenPortsMany(["pane-a"])).toEqual({});
  });
});

// docs/specs/transport.md -> "The governing rule": standalone restores window
// state, so nothing is deleted at boot and the record is claimed once.
describe("TauriAdapter window persistence", () => {
  const session = { version: 3 as const, panes: [{ id: "pane-a", title: "A", cwd: "/a", untouched: false }] };
  const windowBlob = {
    version: 1 as const,
    workspaces: [{ id: "ws-1", name: "One", session }],
    activeWorkspaceId: "ws-1",
  };

  /** Stub Rust with a per-command implementation and boot the adapter. */
  async function booted(impl: (cmd: string, args?: Record<string, unknown>) => unknown) {
    const invoke = vi.mocked(rawInvoke);
    invoke.mockClear();
    invoke.mockImplementation((async (cmd: string, args?: Record<string, unknown>) =>
      impl(cmd, args)) as unknown as typeof rawInvoke);
    const adapter = new TauriAdapter();
    await adapter.init();
    // `init()` starts the recovery claim without awaiting it; the boot awaits it
    // before planning (`standalone/src/main.tsx`), so do the same here.
    await adapter.recoveryReady;
    return { adapter, invoke };
  }

  it("persists, and never clears the snapshot at boot", async () => {
    const { adapter, invoke } = await booted((cmd) => (cmd === "load_session" ? JSON.stringify(windowBlob) : undefined));

    expect(adapter.persistsSession).toBe(true);
    expect(adapter.getWindowState()).toEqual(windowBlob);
    expect(invoke.mock.calls.map(([cmd]) => cmd)).not.toContain("clear_session");
    adapter.shutdown();
  });

  it("wraps a pre-Window blob as the one Workspace", async () => {
    const { adapter } = await booted((cmd) => (cmd === "load_session" ? JSON.stringify(session) : undefined));
    expect(adapter.getWindowState()?.workspaces.map((ws) => ws.session)).toEqual([session]);
    adapter.shutdown();
  });

  it("claims the recovery commands for every saved pane, before restore reads them", async () => {
    const { adapter, invoke } = await booted((cmd) => {
      if (cmd === "load_session") return JSON.stringify(windowBlob);
      if (cmd === "take_recovery_commands") return { "pane-a": "claude --continue" };
      return undefined;
    });

    expect(invoke).toHaveBeenCalledWith("take_recovery_commands", { paneIds: ["pane-a"] });
    // Synchronous by the time the cold restore asks, which is what awaiting
    // `recoveryReady` before planning buys.
    expect(adapter.getRecoveryCommands()).toEqual({ "pane-a": "claude --continue" });
    adapter.shutdown();
  });

  it("restores without recovery when the record cannot be read", async () => {
    const { adapter } = await booted((cmd) => {
      if (cmd === "load_session") return JSON.stringify(windowBlob);
      if (cmd === "take_recovery_commands") throw new Error("sidecar gone");
      return undefined;
    });
    expect(adapter.getRecoveryCommands()).toEqual({});
    adapter.shutdown();
  });

  it("asks for nothing when there are no saved panes", async () => {
    const { adapter, invoke } = await booted(() => undefined);
    expect(invoke.mock.calls.map(([cmd]) => cmd)).not.toContain("take_recovery_commands");
    expect(adapter.getRecoveryCommands()).toEqual({});
    adapter.shutdown();
  });

  it("captures agent recovery and proceeds when the capture fails", async () => {
    const { adapter, invoke } = await booted((cmd) => {
      if (cmd === "capture_agent_recovery") throw new Error("sidecar gone");
      return undefined;
    });
    await expect(adapter.captureAgentRecovery(1300)).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("capture_agent_recovery", { timeout: 1300 });
    adapter.shutdown();
  });
});

// The archive port is a thin bridge to three Rust commands (docs/specs/notepad.md).
// What is covered here is exactly what this side owns: the None → null mapping,
// serialization, and passing the stored string through unparsed — the
// compare-and-swap itself is Rust's, and validation is the shared layer's.
describe("TauriAdapter notepad archive", () => {
  const archive: NotepadArchiveV1 = { version: 1, batches: [] };

  function invoking(impl: (cmd: string, args?: Record<string, unknown>) => unknown) {
    const invoke = vi.mocked(rawInvoke);
    invoke.mockClear();
    invoke.mockImplementation((async (cmd: string, args?: Record<string, unknown>) =>
      impl(cmd, args)) as unknown as typeof rawInvoke);
    return { adapter: new TauriAdapter(), invoke };
  }

  it("reads a missing archive as null", async () => {
    const { adapter } = invoking(() => null);
    expect(await adapter.notepadArchive.load()).toBeNull();
  });

  it("hands the stored string through unparsed, with its revision", async () => {
    // Deliberately not valid JSON: an unreadable archive has to reach the shared
    // validator as-is, not fail here (its recovery is a user decision).
    const { adapter } = invoking(() => ["{ not an archive", "7"]);
    expect(await adapter.notepadArchive.load()).toEqual({
      raw: "{ not an archive",
      revision: "7",
    });
  });

  it("serializes a save and names the revision it read", async () => {
    const { adapter, invoke } = invoking(() => "ok");
    expect(await adapter.notepadArchive.save(archive, "3")).toBe("ok");
    expect(invoke).toHaveBeenCalledWith("save_notepad_archive", {
      state: JSON.stringify(archive),
      baseRevision: "3",
    });

    // Nothing stored yet: the base revision is null, not omitted.
    await adapter.notepadArchive.save(archive, null);
    expect(invoke).toHaveBeenLastCalledWith("save_notepad_archive", {
      state: JSON.stringify(archive),
      baseRevision: null,
    });
  });

  it("reports a conflict rather than throwing, so the caller can retry", async () => {
    const { adapter } = invoking(() => "conflict");
    expect(await adapter.notepadArchive.save(archive, "0")).toBe("conflict");
  });

  it("moves an unreadable archive aside through the Rust command", async () => {
    const { adapter, invoke } = invoking(() => undefined);
    await adapter.notepadArchive.resetUnreadable();
    expect(invoke).toHaveBeenCalledWith("reset_notepad_archive");
  });

  it("rejects when the host cannot store the archive", async () => {
    // A closure that cannot archive its notes must take the failure path.
    const { adapter } = invoking(() => {
      throw new Error("disk full");
    });
    await expect(adapter.notepadArchive.save(archive, null)).rejects.toThrow("disk full");
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

  // A transferred pane's new window sees nothing but the replay: Rust drops the
  // gap's semantic events because this path re-derives them, so it must rebuild
  // both halves — pane state and the AlertManager's watch.
  it("rebuilds alert state from a replay, not only pane state", async () => {
    const { adapter, deliver } = await listening();
    const alerts: AlertStateDetail[] = [];
    adapter.onAlertState((detail) => void alerts.push(detail));
    // The rule set is the sidecar's; this window hears it as a broadcast.
    deliver("alert:watchedCommands", { names: ["sleep"] });

    deliver("pty:replay", {
      id: "replay-pty",
      data: "\x1b]633;E;sleep 5\x07\x1b]633;C\x07",
    });

    expect(getTerminalPaneState("replay-pty").currentCommand?.rawCommandLine).toBe("sleep 5");
    expect(alerts.some((detail) => detail.id === "replay-pty" && detail.watchingEnabled)).toBe(true);
  });

  it("settles the replayed watch when a marked buffer belongs to an exited PTY", async () => {
    const { adapter, deliver } = await listening();
    const alerts: AlertStateDetail[] = [];
    adapter.onAlertState((detail) => void alerts.push(detail));
    deliver("alert:watchedCommands", { names: ["sleep"] });
    deliver("pty:list", { ptys: [{ id: "exited-replay", alive: false, exitCode: 7 }], requestId: "handback-1" });
    deliver("pty:replay", {
      id: "exited-replay", requestId: "handback-1",
      data: "\x1b]633;E;sleep 5\x07\x1b]633;C\x07",
    });
    expect(getTerminalPaneState("exited-replay").currentCommand).toBeNull();
    expect(alerts[alerts.length - 1]?.watchingEnabled).toBe(false);
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
