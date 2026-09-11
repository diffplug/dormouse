// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformAdapter, PtyInfo } from "dormouse-lib/lib/platform/types";
import type {
  PreparedWorkspaceTransfer,
  WorkspaceTransferPayload,
} from "dormouse-lib/components/wall/workspace-transfer";

/**
 * The two halves of a Workspace move. What is observable here is the ordering —
 * the source releases before it invokes, the target arms before it says it is
 * ready — and the two rules that keep the Sessions intact: nothing is killed,
 * and the plan is parked before the Workspace is created
 * (`docs/specs/standalone.md` → "Transfer").
 */

const mocks = vi.hoisted(() => ({
  writes: [] as string[],
  invoke: vi.fn(async (_cmd: string, _args?: unknown) => undefined as unknown),
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

// The resume builds real xterm instances; jsdom has no canvas, and what this
// file is about is the protocol around them.
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit(): void {}
    proposeDimensions(): { cols: number; rows: number } { return { cols: 80, rows: 24 }; }
  },
}));
vi.mock("@xterm/addon-image", () => ({ ImageAddon: class {} }));
vi.mock("@xterm/addon-serialize", () => ({ SerializeAddon: class { serialize(): string { return ""; } } }));
vi.mock("@xterm/addon-unicode-graphemes", () => ({ UnicodeGraphemesAddon: class {} }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    parser = { registerCsiHandler: () => ({ dispose: () => {} }) };
    modes = { mouseTrackingMode: "none" as const, bracketedPasteMode: false };
    loadAddon(): void {}
    open(): void {}
    write(data: string, callback?: () => void): void { mocks.writes.push(data); callback?.(); }
    focus(): void {}
    blur(): void {}
    onData(): { dispose: () => void } { return { dispose: () => {} }; }
    onResize(): { dispose: () => void } { return { dispose: () => {} }; }
    onRender(): { dispose: () => void } { return { dispose: () => {} }; }
    dispose(): void {}
  },
}));

import {
  bootFromTearOut,
  initWorkspaceMoves,
  tearOutWorkspace,
  transferWorkspaceTo,
  _resetWorkspaceMovesForTesting,
} from "./workspace-move";
import { workspaceDropTarget, workspaceTabRect } from "./workspace-tabs";
import { registerWallHandle, resetWallHandles, stubWallHandle } from "dormouse-lib/components/wall/wall-handles";
import {
  getWorkspaceBootPlan,
  resetWorkspaceBootPlans,
} from "dormouse-lib/components/wall/workspace-boot-plans";
import { createWorkspace, getWorkspacesSnapshot, resetWorkspaces } from "dormouse-lib/lib/workspace-store";
import { getNotes, clearAllNotepads } from "dormouse-lib/lib/notepad/notepad-store";
import {
  getWindowSnapshot,
  publishWorkspaceSession,
  resetWindowSessionAggregator,
} from "dormouse-lib/lib/window-session-aggregator";
import { getTerminalInstance } from "dormouse-lib/lib/terminal-registry";
import { setPlatform } from "dormouse-lib/lib/platform";
import { disposeAllSessions, getOrCreateTerminal } from "dormouse-lib/lib/terminal-registry";
import { FakePtyAdapter } from "dormouse-lib/lib/platform/fake-adapter";

const WORKSPACE_ID = "ws-moving";

/** Drain the microtask chain the arrival drain runs on. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** The source's second half has gone over: the marks passed and the content
 *  followed. A hand-off resolves only when the target settles it, so a test
 *  that needs the invoke sequence waits for this rather than the call. */
const contentSent = () => vi.waitFor(() =>
  expect(mocks.invoke).toHaveBeenCalledWith("transfer_workspace_content", expect.anything()));

function payload(overrides: Partial<WorkspaceTransferPayload> = {}): WorkspaceTransferPayload {
  return {
    workspaceId: WORKSPACE_ID,
    workspace: {
      id: WORKSPACE_ID,
      name: "Deploys",
      session: {
        version: 3,
        panes: [{ id: "pane-a", title: "a", cwd: "/tmp", untouched: false, alert: null }],
      },
    },
    notepad: {
      surfaces: [{
        surfaceId: "pane-a",
        surfaceTitle: "a",
        surfaceKind: "terminal",
        cwd: null,
        terminalId: "pane-a",
        notes: [{ id: "n1", createdAt: 1, content: { kind: "plain", text: "keep me" } }],
      }],
      stagedDeletions: {},
    },
    terminalIds: ["pane-a"],
    allIds: ["pane-a"],
    ...overrides,
  };
}

/** Rust's arrival table: what is in flight into this window, keyed by Workspace. */
let arrivals: WorkspaceTransferPayload[] = [];

/** Push one `pty:replay` at whatever this window's adapter has subscribed. */
let deliverReplay: (detail: { id: string; data: string; requestId?: string }) => void = () => {};

/** A prepared transfer whose commit is observable. */
function prepared(
  onCommit: () => void = () => {},
  overrides: Partial<WorkspaceTransferPayload> = {},
): PreparedWorkspaceTransfer {
  return { payload: payload(overrides), commit: onCommit };
}

/**
 * The host half of the protocol, in memory: an arrival lives from the source's
 * invoke until `adopt_done` or `adopt_failed` retires it, `take_arrivals` does
 * not consume, and `adopt_ready` answers with **exactly that arrival's** ids.
 *
 * The adapter's `pty:list` / `pty:replay` answer only once something asks —
 * which is the property the `adopt_ready` hop exists to guarantee.
 */
function fakePlatform(
  order: string[] = [],
  opts: { answer?: boolean; marks?: Record<string, number>; stamp?: boolean } = {},
): PlatformAdapter {
  const platform = new FakePtyAdapter();
  let listHandler: ((detail: { ptys: PtyInfo[]; requestId?: string }) => void) | null = null;
  let replayHandler: ((detail: { id: string; data: string; requestId?: string }) => void) | null = null;
  vi.spyOn(platform, "onPtyList").mockImplementation((handler) => { listHandler = handler; });
  vi.spyOn(platform, "offPtyList").mockImplementation(() => { listHandler = null; });
  vi.spyOn(platform, "onPtyReplay").mockImplementation((handler) => { replayHandler = handler; });
  vi.spyOn(platform, "offPtyReplay").mockImplementation(() => { replayHandler = null; });
  // What Rust routes to this window unasked: a hand-back's since-mark replay.
  deliverReplay = (detail) => replayHandler?.(detail);
  let markedHandler: ((detail: { id: string; mark: number; requestId?: string }) => void) | null = null;
  (platform as unknown as { onPtyMarked: unknown }).onPtyMarked = (handler: typeof markedHandler) => {
    markedHandler = handler;
    return () => { markedHandler = null; };
  };
  vi.spyOn(platform, "requestInit").mockImplementation(() => {
    throw new Error("an arrival must never ask for the whole Window");
  });
  // The fake adapter has no AlertManager, so give it the optional hook the
  // arrival seeds a persisted TODO through.
  (platform as unknown as { alertSeed: unknown }).alertSeed = vi.fn();
  mocks.invoke.mockImplementation(async (cmd: string, args?: unknown) => {
    order.push(cmd);
    const workspaceId = (args as { workspaceId?: string; payload?: { workspaceId?: string } } | undefined)?.workspaceId
      ?? (args as { payload?: { workspaceId?: string } } | undefined)?.payload?.workspaceId;
    const settle = () => {
      const at = arrivals.findIndex((arrival) => arrival.workspaceId === workspaceId);
      if (at < 0) throw new Error(`no arrival of '${workspaceId}'`);
      arrivals.splice(at, 1);
    };
    if (cmd === "take_arrivals") return arrivals.map((arrival) => ({ ...arrival }));
    if (cmd === "transfer_workspace" || cmd === "open_workspace_window") {
      // The host stamps each id's mark in the stream, behind every byte the
      // source was sent; the source serializes at that line. Stamped *before*
      // the invoke resolves, as Rust does inside `begin_arrival`: a source that
      // only listens once the invoke is back misses every one of them.
      const ids = opts.stamp === false ? [] : (args as { payload: { terminalIds: string[] } }).payload.terminalIds;
      for (const id of ids) markedHandler?.({ id, mark: opts.marks?.[id] ?? 0, requestId: `mark-${workspaceId}` });
    }
    if (cmd === "adopt_done" || cmd === "adopt_failed") { settle(); return undefined; }
    if (cmd === "adopt_ready") {
      const arrival = arrivals.find((entry) => entry.workspaceId === workspaceId);
      if (!arrival) throw new Error(`no arrival of '${workspaceId}'`);
      if (opts.answer === false) return undefined;
      order.push(`answered:${workspaceId}`);
      // The host echoes the collector's own token, and lists exactly this
      // arrival's ids: two arrivals at once must not finish on each other's.
      const requestId = (args as { requestId?: string } | undefined)?.requestId;
      listHandler?.({
        ptys: arrival.terminalIds.map((id) => ({ id, alive: true }) as PtyInfo),
        requestId,
      });
      for (const id of arrival.terminalIds) {
        replayHandler?.({ id, data: `scrollback:${id}`, requestId });
      }
    }
    return undefined;
  });
  setPlatform(platform);
  return platform;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.writes.length = 0;
  arrivals = [];
  disposeAllSessions();
  mocks.invoke.mockResolvedValue(undefined);
  mocks.listen.mockResolvedValue(() => {});
  resetWallHandles();
  resetWorkspaceBootPlans();
  resetWorkspaces();
  resetWindowSessionAggregator();
  clearAllNotepads();
  _resetWorkspaceMovesForTesting();
});

/** Fire the listener `initWorkspaceMoves` registered for `event`. */
const emit = async (event: string, data: unknown) => {
  const calls = mocks.listen.mock.calls as unknown as Array<[string, (e: { payload: unknown }) => void]>;
  calls.find(([name]) => name === event)![1]({ payload: data });
  await new Promise((r) => setTimeout(r, 0));
};

describe("the source half", () => {
  it("prepares the Workspace, tells the host, and commits only when it lands", async () => {
    const order: string[] = [];
    registerWallHandle(stubWallHandle(WORKSPACE_ID, {
      prepareWorkspaceTransfer: async () => {
        order.push("prepare");
        return prepared(() => order.push("commit"));
      },
    }));
    initWorkspaceMoves(fakePlatform(order));

    const moved = transferWorkspaceTo(WORKSPACE_ID, "ws-2", { x: 10, y: 4 });
    await contentSent();

    // The record is built while the Sessions are live. Nothing is released at
    // the invoke: the target can still refuse, and a Workspace released here
    // would have no Sessions and no window that owned them. The content
    // follows once the marks pass.
    expect(order.filter((cmd) => cmd !== "take_arrivals"))
      .toEqual(["prepare", "transfer_workspace", "transfer_workspace_content"]);
    const [, args] = mocks.invoke.mock.calls.find(([cmd]) => cmd === "transfer_workspace")!;
    expect(args).toMatchObject({ to: "ws-2", payload: { at: { x: 10, y: 4 }, terminalIds: ["pane-a"] } });
    expect(order).not.toContain("commit");

    await emit("dormouse://workspace-departed", { workspaceId: WORKSPACE_ID });
    expect(order).toContain("commit");
    // `moved` is the target's adoption, not the host taking the invoke: a
    // caller told sooner (`dor workspace move`) would read a move that can
    // still be handed back.
    await expect(moved).resolves.toEqual({ moved: true });
  });

  it("carries a strip slot named outright, which the target reads ahead of a pointer", async () => {
    registerWallHandle(stubWallHandle(WORKSPACE_ID, { prepareWorkspaceTransfer: async () => prepared() }));
    initWorkspaceMoves(fakePlatform());

    void transferWorkspaceTo(WORKSPACE_ID, "ws-2", undefined, 2);
    await settle();

    const [, args] = mocks.invoke.mock.calls.find(([cmd]) => cmd === "transfer_workspace")!;
    expect(args).toMatchObject({ to: "ws-2", payload: { index: 2 } });
    expect((args as { payload: { at?: unknown } }).payload.at).toBeUndefined();
  });

  it("keeps a transferring Workspace out of every snapshot until it settles", async () => {
    // Its shells already belong to the target, so a quit in the gap must not
    // write the same Workspace into two Windows and restore it twice.
    initWorkspaceMoves(fakePlatform());
    publishWorkspaceSession(WORKSPACE_ID, payload().workspace.session);
    createWorkspace({ id: WORKSPACE_ID, name: "Deploys" });
    registerWallHandle(stubWallHandle(WORKSPACE_ID, {
      prepareWorkspaceTransfer: async () => prepared(),
    }));
    expect(getWindowSnapshot().workspaces.map((w) => w.id)).toContain(WORKSPACE_ID);

    const moved = transferWorkspaceTo(WORKSPACE_ID, "ws-2", { x: 10, y: 4 });
    await settle();
    expect(getWindowSnapshot().workspaces.map((w) => w.id)).not.toContain(WORKSPACE_ID);

    // Refused: it is this Window's again, snapshot included, and the caller
    // hears the host's reason rather than `moved`.
    await emit("dormouse://workspace-arrival-failed", { workspaceId: WORKSPACE_ID, reason: "closed" });
    expect(getWindowSnapshot().workspaces.map((w) => w.id)).toContain(WORKSPACE_ID);
    await expect(moved).resolves.toEqual({ moved: false, reason: "closed" });
  });

  it("keeps the Workspace, with its Sessions, when the target never adopts it", async () => {
    // The target window closed mid-arrival: Rust hands the shells back and says
    // so. Nothing was released, so there is nothing to restore.
    const committed = vi.fn();
    initWorkspaceMoves(fakePlatform());
    registerWallHandle(stubWallHandle(WORKSPACE_ID, {
      prepareWorkspaceTransfer: async () => prepared(committed),
    }));
    createWorkspace({ id: WORKSPACE_ID, name: "Deploys" });

    const moved = transferWorkspaceTo(WORKSPACE_ID, "ws-2", { x: 10, y: 4 });
    await settle();
    await emit("dormouse://workspace-arrival-failed", {
      workspaceId: WORKSPACE_ID,
      reason: "the target window closed mid-arrival",
    });

    expect(committed).not.toHaveBeenCalled();
    expect(getWorkspacesSnapshot().workspaces.map((w) => w.id)).toContain(WORKSPACE_ID);
    await expect(moved).resolves.toEqual({ moved: false, reason: "the target window closed mid-arrival" });
  });

  it("writes a hand-back's since-mark replay into the xterms that never left", async () => {
    // Between the mark and the hand-back every byte went to the target, or
    // nowhere. Rust replays that slice to this window; it lands in the existing
    // instances, and no Session is restarted or killed for it.
    const platform = fakePlatform([], { marks: { "pane-a": 42 } });
    const killed = vi.spyOn(platform, "killPty");
    initWorkspaceMoves(platform);
    getOrCreateTerminal("pane-a");
    registerWallHandle(stubWallHandle(WORKSPACE_ID, {
      prepareWorkspaceTransfer: async () => prepared(),
    }));
    createWorkspace({ id: WORKSPACE_ID, name: "Deploys" });
    void transferWorkspaceTo(WORKSPACE_ID, "ws-2", { x: 10, y: 4 });
    await contentSent();
    mocks.writes.length = 0;

    await emit("dormouse://workspace-arrival-failed", { workspaceId: WORKSPACE_ID, reason: "wedged", replayIds: ["pane-a"] });
    // Another collection's replay is not this one's.
    deliverReplay({ id: "pane-a", data: "not-mine", requestId: "boot-1" });
    deliverReplay({ id: "pane-a", data: "since-the-mark", requestId: `handback-${WORKSPACE_ID}` });

    expect(mocks.writes).toEqual(["since-the-mark"]);
    expect(killed).not.toHaveBeenCalled();
    // The last id lets go of the adapter.
    expect(platform.offPtyReplay).toHaveBeenCalled();
    deliverReplay({ id: "pane-a", data: "late", requestId: `handback-${WORKSPACE_ID}` });
    expect(mocks.writes).toEqual(["since-the-mark"]);
  });

  it("receives recovery replay when hand-back precedes the source invoke reply", async () => {
    const platform = fakePlatform();
    initWorkspaceMoves(platform);
    getOrCreateTerminal("pane-a");
    createWorkspace({ id: WORKSPACE_ID });
    registerWallHandle(stubWallHandle(WORKSPACE_ID, { prepareWorkspaceTransfer: async () => prepared() }));
    const host = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (cmd, args) => {
      const result = await host(cmd, args);
      if (cmd === "transfer_workspace") {
        await emit("dormouse://workspace-arrival-failed", { workspaceId: WORKSPACE_ID, replayIds: ["pane-a"] });
        mocks.writes.length = 0;
        deliverReplay({ id: "pane-a", data: "early-gap", requestId: `handback-${WORKSPACE_ID}` });
      }
      return result;
    });
    await transferWorkspaceTo(WORKSPACE_ID, "ws-2", { x: 0, y: 0 });
    expect(mocks.writes).toEqual(["early-gap"]);
    expect(mocks.invoke).not.toHaveBeenCalledWith("transfer_workspace_content", expect.anything());
  });

  it("accepts no hand-back replay for an id the host never marked", async () => {
    // An unmarked id was serialized whole and its xterm still holds every
    // byte: Rust asks the sidecar for nothing, and a whole-buffer replay
    // arriving anyway would paint the transcript twice.
    vi.useFakeTimers();
    try {
      const platform = fakePlatform([], { stamp: false });
      initWorkspaceMoves(platform);
      getOrCreateTerminal("pane-a");
      registerWallHandle(stubWallHandle(WORKSPACE_ID, {
        prepareWorkspaceTransfer: async () => prepared(),
      }));
      createWorkspace({ id: WORKSPACE_ID, name: "Deploys" });
      const moved = transferWorkspaceTo(WORKSPACE_ID, "ws-2", { x: 10, y: 4 });
      await vi.advanceTimersByTimeAsync(3000); // past the mark wait
      await vi.advanceTimersByTimeAsync(0); // the content follows the serialization
      const [, args] = mocks.invoke.mock.calls.find(([cmd]) => cmd === "transfer_workspace_content")!;
      expect(args).toMatchObject({ content: { terminals: { "pane-a": { serialized: "" } } } });
      mocks.writes.length = 0;

      const failed = emit("dormouse://workspace-arrival-failed", { workspaceId: WORKSPACE_ID, reason: "wedged", replayIds: [] });
      await vi.advanceTimersByTimeAsync(1);
      await failed;
      deliverReplay({ id: "pane-a", data: "whole-buffer", requestId: `handback-${WORKSPACE_ID}` });

      expect(mocks.writes).toEqual([]);
      expect(getWorkspacesSnapshot().workspaces.map((w) => w.id)).toContain(WORKSPACE_ID);
      // The move itself settles on the hand-back, with its reason.
      expect(await moved).toEqual({ moved: false, reason: "wedged" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases only the Workspace that departed", async () => {
    // Two in flight into the same window: one landing must not take the other
    // with it (Rust announces one departure per arrival, from its `adopt_done`).
    const committed = { first: vi.fn(), second: vi.fn() };
    initWorkspaceMoves(fakePlatform());
    for (const [id, commit] of [["ws-a", committed.first], ["ws-b", committed.second]] as const) {
      createWorkspace({ id, name: id });
      registerWallHandle(stubWallHandle(id, {
        prepareWorkspaceTransfer: async () => prepared(commit, { workspaceId: id }),
      }));
      void transferWorkspaceTo(id, "ws-2", { x: 0, y: 0 });
      await settle();
    }

    await emit("dormouse://workspace-departed", { workspaceId: "ws-a" });

    expect(committed.first).toHaveBeenCalledTimes(1);
    expect(committed.second).not.toHaveBeenCalled();
    expect(getWorkspacesSnapshot().workspaces.map((w) => w.id)).toContain("ws-b");
  });

  it("leaves the source Workspace intact when the host refuses", async () => {
    // The target window can close between the drag's last probe and the drop.
    mocks.invoke.mockRejectedValue(new Error("no window 'ws-2'"));
    const committed = vi.fn();
    registerWallHandle(stubWallHandle(WORKSPACE_ID, {
      prepareWorkspaceTransfer: async () => prepared(committed),
    }));

    // A refused invoke settles at once, with the host's reason.
    await expect(transferWorkspaceTo(WORKSPACE_ID, "ws-2", { x: 10, y: 4 }))
      .resolves.toEqual({ moved: false, reason: "no window 'ws-2'" });

    expect(committed).not.toHaveBeenCalled();
  });

  it("leaves the source Workspace intact when the tear-out cannot build a window", async () => {
    mocks.invoke.mockRejectedValue(new Error("build window ws-3: no display"));
    const committed = vi.fn();
    registerWallHandle(stubWallHandle(WORKSPACE_ID, {
      prepareWorkspaceTransfer: async () => prepared(committed),
    }));

    await expect(tearOutWorkspace(WORKSPACE_ID, { x: 90, y: 12 }))
      .resolves.toEqual({ moved: false, reason: "build window ws-3: no display" });

    expect(committed).not.toHaveBeenCalled();
  });

  it("tears out into a new window carrying the tab's grab offset", async () => {
    registerWallHandle(stubWallHandle(WORKSPACE_ID, { prepareWorkspaceTransfer: async () => prepared() }));
    // Only Rust knows where the cursor is on screen, so the payload carries
    // where the tab should sit inside the new window rather than a position.
    void tearOutWorkspace(WORKSPACE_ID, { x: 90, y: 12 });
    await settle();
    expect(mocks.invoke).toHaveBeenCalledWith("open_workspace_window", {
      payload: expect.objectContaining({ grab: { x: 90, y: 12 } }),
    });
  });

  it("does nothing when the Workspace has no mounted Wall", async () => {
    await expect(transferWorkspaceTo("gone", "ws-2", { x: 0, y: 0 })).resolves.toMatchObject({ moved: false });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("the target half", () => {
  it("arms its collector, asks by Workspace, mounts, and only then releases the source", async () => {
    const order: string[] = [];
    const platform = fakePlatform(order);
    arrivals = [payload()];
    initWorkspaceMoves(platform);
    await settle();

    // The `adopt_ready` hop is what removes the "arrived before armed" bug
    // class: nothing is listed or replayed until the collector is listening.
    // `adopt_done` is last, because it is what tells the source to let go.
    expect(order).toEqual(["take_arrivals", "adopt_ready", `answered:${WORKSPACE_ID}`, "adopt_done"]);
    expect(mocks.invoke).toHaveBeenCalledWith("adopt_ready", expect.objectContaining({ workspaceId: WORKSPACE_ID }));
    // The plan is parked before the Workspace exists, because creating it
    // mounts the Wall that reads it.
    expect(getWorkspaceBootPlan(WORKSPACE_ID)).toBeTruthy();
    const { workspaces, activeId } = getWorkspacesSnapshot();
    expect(workspaces.map((workspace) => workspace.name)).toContain("Deploys");
    expect(activeId).toBe(WORKSPACE_ID);
    // The notes travelled in the payload; nothing was archived.
    expect(getNotes("pane-a").map((note) => note.content)).toEqual([{ kind: "plain", text: "keep me" }]);
  });

  it("seeds the persisted alert before asking for the replay that rebuilds WATCHING", async () => {
    const order: string[] = [];
    const platform = fakePlatform(order);
    vi.mocked(platform.alertSeed!).mockImplementation(() => { order.push("seed"); });
    arrivals = [payload()];
    arrivals[0].workspace.session.panes[0].alert = { status: "WATCHING_DISABLED", todo: true, notification: null };
    initWorkspaceMoves(platform);
    await settle();
    expect(order.indexOf("seed")).toBeGreaterThan(-1);
    expect(order.indexOf("seed")).toBeLessThan(order.indexOf("adopt_ready"));
  });

  it("resumes each of two simultaneous arrivals over its own PTYs", async () => {
    // A tear-out with a second tab dropped on it moments later. A window-wide
    // answer would let each collector finish on the other's shells.
    const order: string[] = [];
    const platform = fakePlatform(order);
    arrivals = [
      payload({ workspaceId: "ws-a", terminalIds: ["pane-a"], allIds: ["pane-a"] }),
      payload({
        workspaceId: "ws-b",
        workspace: {
          id: "ws-b",
          name: "Builds",
          session: {
            version: 3,
            panes: [{ id: "pane-b", title: "b", cwd: "/tmp", untouched: false, alert: null }],
          },
        },
        notepad: { surfaces: [], stagedDeletions: {} },
        terminalIds: ["pane-b"],
        allIds: ["pane-b"],
      }),
    ];
    arrivals[0]!.workspace = { ...arrivals[0]!.workspace, id: "ws-a" };

    initWorkspaceMoves(platform);
    await settle();

    expect(order.filter((entry) => entry.startsWith("answered")))
      .toEqual(["answered:ws-a", "answered:ws-b"]);
    expect(getWorkspaceBootPlan("ws-a")?.initialPaneIds).toEqual(["pane-a"]);
    expect(getWorkspaceBootPlan("ws-b")?.initialPaneIds).toEqual(["pane-b"]);
    // Both settled, so Rust is holding nothing.
    expect(arrivals).toEqual([]);
  });

  it("mounts a browser-only arrival, which names no PTYs at all", async () => {
    // Distinguishable from a swept suppression precisely because the record
    // says `terminalIds: []`: the host answers with an empty list at once
    // rather than leaving the collector to sit out its timeout.
    const platform = fakePlatform();
    arrivals = [payload({ terminalIds: [], allIds: ["browser-1"] })];

    initWorkspaceMoves(platform);
    await settle();

    expect(getWorkspacesSnapshot().workspaces.map((w) => w.name)).toContain("Deploys");
    expect(mocks.invoke).toHaveBeenCalledWith("adopt_done", { workspaceId: WORKSPACE_ID });
  });

  it("mounts each arrival once, however often the queue is drained", async () => {
    // `take_arrivals` does not consume: the record settles at `adopt_done`, and
    // the boot drain and the nudge overlap by design.
    const platform = fakePlatform();
    arrivals = [payload()];
    initWorkspaceMoves(platform);
    await emit("dormouse://workspace-arriving", undefined);
    await settle();

    expect(getWorkspacesSnapshot().workspaces.filter((w) => w.id === WORKSPACE_ID)).toHaveLength(1);
  });

  it("lands at the slot the payload names, ahead of the pointer's", async () => {
    // `dor workspace move --window ws-2 --index 0` names the target's slot
    // outright; a drag sends only a point, and with no tab under it appends.
    createWorkspace({ id: "ws-here", name: "Here" });
    arrivals = [{ ...payload(), index: 0, at: { x: 900, y: 0 } } as WorkspaceTransferPayload];

    initWorkspaceMoves(fakePlatform());
    await settle();

    expect(getWorkspacesSnapshot().workspaces[0]?.id).toBe(WORKSPACE_ID);
  });

  it("seeds a persisted TODO into this window's own AlertManager", async () => {
    const platform = fakePlatform();
    const alert = { kind: "todo" } as never;
    const moving = payload();
    moving.workspace.session.panes[0]!.alert = alert;
    arrivals = [moving];

    initWorkspaceMoves(platform);
    await settle();

    expect(platform.alertSeed).toHaveBeenCalledWith("pane-a", alert);
  });

  it("hands the Workspace back when the host never answers, rather than restarting live shells", async () => {
    // A timed-out collection is not a collection that found no PTYs: those
    // shells are still running, and a cold restore would start a second set.
    vi.useFakeTimers();
    try {
      const platform = fakePlatform([], { answer: false });
      arrivals = [payload()];
      initWorkspaceMoves(platform);
      await vi.advanceTimersByTimeAsync(5000);

      expect(getWorkspacesSnapshot().workspaces.map((w) => w.name)).not.toContain("Deploys");
      expect(getWorkspaceBootPlan(WORKSPACE_ID)).toEqual({});
      expect(mocks.invoke).toHaveBeenCalledWith("adopt_failed", expect.objectContaining({
        workspaceId: WORKSPACE_ID,
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("unwinds the mount when adopt_done is refused, releasing the Sessions rather than killing them", async () => {
    const platform = fakePlatform();
    const killPty = vi.spyOn(platform, "killPty");
    const host = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      // The `ARRIVAL_MAX` watchdog retired the record while this window was
      // wedged between the drain and the mount: Rust has handed the shells
      // back to the source, so `adopt_done` finds no arrival to settle.
      if (cmd === "adopt_done") arrivals = [];
      return host(cmd, args);
    });
    // The Wall this window mounts for the arrival, with its release observable.
    const released = vi.fn();
    registerWallHandle(stubWallHandle(WORKSPACE_ID, {
      prepareWorkspaceTransfer: async () => prepared(released),
    }));
    arrivals = [payload()];
    initWorkspaceMoves(platform);
    await settle();
    await settle();

    expect(mocks.invoke).toHaveBeenCalledWith("adopt_done", { workspaceId: WORKSPACE_ID });
    // The source kept the Workspace, so this window holds none of it: not in
    // the store, not in the snapshot it writes, no plan parked for it.
    expect(getWorkspacesSnapshot().workspaces.map((w) => w.id)).not.toContain(WORKSPACE_ID);
    expect(getWindowSnapshot().workspaces.map((w) => w.id)).not.toContain(WORKSPACE_ID);
    expect(getWorkspaceBootPlan(WORKSPACE_ID)).toEqual({});
    // Its Sessions were released — the shells are the source's again — and
    // nothing was killed.
    expect(released).toHaveBeenCalledTimes(1);
    expect(killPty).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalledWith("adopt_failed", expect.anything());
  });

  it("closes the window when its last Workspace leaves, instead of emptying it", async () => {
    initWorkspaceMoves(fakePlatform());
    const workspaceId = getWorkspacesSnapshot().activeId;
    registerWallHandle(stubWallHandle(workspaceId, {
      prepareWorkspaceTransfer: async () => prepared(() => {}, { workspaceId }),
    }));
    const moved = transferWorkspaceTo(workspaceId, "ws-2", { x: 0, y: 0 });
    await contentSent();
    const order: string[] = [];
    void moved.then(() => order.push("answered"));
    mocks.invoke.mockImplementation(async (cmd: string) => void order.push(cmd));

    await emit("dormouse://workspace-departed", { workspaceId });

    // Nothing ended — the Surfaces are alive in another window — so this is a
    // close with no confirmation, no archive and no kill. The caller's answer
    // goes first: Rust destroys the window on `close_window`, and a `dor
    // workspace move` that emptied it still has `moved` to say.
    expect(order).toEqual(["answered", "close_window"]);
    expect(getWorkspacesSnapshot().workspaces).toHaveLength(1);
  });
});

describe("a transfer's content", () => {
  it("serializes each terminal at the host's mark and hands the content over behind the invoke", async () => {
    const order: string[] = [];
    initWorkspaceMoves(fakePlatform(order, { marks: { "pane-a": 42 } }));
    registerWallHandle(stubWallHandle(WORKSPACE_ID, {
      prepareWorkspaceTransfer: async () => prepared(),
    }));

    void transferWorkspaceTo(WORKSPACE_ID, "ws-2", { x: 1, y: 1 });
    await contentSent();

    expect(order.filter((cmd) => cmd !== "take_arrivals")).toEqual(["transfer_workspace", "transfer_workspace_content"]);
    const [, args] = mocks.invoke.mock.calls.find(([cmd]) => cmd === "transfer_workspace_content")!;
    expect(args).toEqual({
      workspaceId: WORKSPACE_ID,
      content: { terminals: { "pane-a": { serialized: "", mark: 42 } }, pins: [] },
    });
  });

  it("writes the source's buffer ahead of the since-mark replay when it mounts the arrival", async () => {
    arrivals = [payload({
      terminals: { "pane-a": { serialized: "\u001b[1mfrom-source\u001b[0m", mark: 42 } },
      pins: [],
    } as Partial<WorkspaceTransferPayload>)];
    await bootFromTearOut(fakePlatform());
    // One write: the rebuilt buffer, then everything after the mark, in order.
    expect(mocks.writes).toContain("\u001b[1mfrom-source\u001b[0mscrollback:pane-a");
    expect(mocks.writes.filter((w) => w.includes("scrollback:pane-a"))).toHaveLength(1);
  });
});

describe("a torn-out window's boot", () => {
  it("boots from the queued payload rather than from disk", async () => {
    const order: string[] = [];
    arrivals = [payload()];
    const platform = fakePlatform(order);

    const plans = await bootFromTearOut(platform);

    expect(order.slice(0, 2)).toEqual(["take_arrivals", "adopt_ready"]);
    expect(order).toContain("adopt_done");
    expect(Object.keys(plans ?? {})).toEqual([WORKSPACE_ID]);
    // The window has no snapshot yet; its Workspace comes from the payload.
    expect(getWorkspacesSnapshot().workspaces.map((workspace) => workspace.name)).toEqual(["Deploys"]);
    expect(getNotes("pane-a")).toHaveLength(1);
  });

  it("boots fresh without installing a refused tear-out or retaining its Sessions", async () => {
    const platform = fakePlatform();
    const kill = vi.spyOn(platform, "killPty");
    const host = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "adopt_done") throw new Error("arrival expired");
      return host(cmd, args);
    });
    arrivals = [payload()];
    expect(await bootFromTearOut(platform)).toBeNull();
    expect(getWorkspacesSnapshot().workspaces.map((w) => w.id)).not.toContain(WORKSPACE_ID);
    expect(getWindowSnapshot().workspaces.map((w) => w.id)).not.toContain(WORKSPACE_ID);
    expect(getNotes("pane-a")).toHaveLength(0);
    expect(getTerminalInstance("pane-a")).toBeNull();
    expect(kill).not.toHaveBeenCalled();
  });

  it("boots fresh, never blank, when the sole arrival cannot be resumed", async () => {
    // `planArrival` throwing into `bootstrap()` would take the whole launch
    // down before `render`. Null instead: the caller restores a fresh Window.
    vi.useFakeTimers();
    try {
      const platform = fakePlatform([], { answer: false });
      arrivals = [payload()];
      const plans = bootFromTearOut(platform);
      await vi.advanceTimersByTimeAsync(5000);

      await expect(plans).resolves.toBeNull();
      expect(mocks.invoke).toHaveBeenCalledWith("adopt_failed", expect.objectContaining({
        workspaceId: WORKSPACE_ID,
      }));
      // Nothing half-installed: the fresh restore owns the Window from here.
      expect(getWorkspacesSnapshot().workspaces.map((w) => w.name)).not.toContain("Deploys");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns null for an ordinary window", async () => {
    const platform = fakePlatform();
    expect(await bootFromTearOut(platform)).toBeNull();
  });

  it("leaves a window with a snapshot to restore itself", async () => {
    // A drop that landed while an ordinary window was booting is mounted over
    // the restore, not instead of it.
    const platform = fakePlatform();
    arrivals = [payload()];
    (platform as unknown as { getWindowState: () => unknown }).getWindowState = () => ({
      version: 1,
      workspaces: [{ id: "saved", name: "Saved", session: { version: 3, panes: [] } }],
      activeWorkspaceId: "saved",
    });

    expect(await bootFromTearOut(platform)).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalledWith("adopt_ready", expect.anything());
  });
});

/** One scan of the strip, shared by the drop index, the caret, and the tear-out
 *  grab offset (`standalone/src/workspace-tabs.ts`). */
describe("workspaceDropTarget", () => {
  function strip(count: number): void {
    document.body.innerHTML = "";
    for (let index = 0; index < count; index += 1) {
      const tab = document.createElement("div");
      tab.dataset.workspaceTab = `w${index}`;
      tab.getBoundingClientRect = () =>
        ({ left: index * 100, right: index * 100 + 100, width: 100, height: 24 }) as DOMRect;
      document.body.append(tab);
    }
  }

  it("inserts before the first tab whose center the drop is left of", () => {
    strip(3);
    expect(workspaceDropTarget(10).index).toBe(0);
    // Between tab 1's center (150) and tab 2's (250): it takes index 2.
    expect(workspaceDropTarget(160).index).toBe(2);
    // Past the last tab's center: appended, which is what undefined means.
    expect(workspaceDropTarget(900).index).toBeUndefined();
  });

  it("hands back the box the caret draws against, and null with no tabs", () => {
    strip(3);
    // The tab the caret goes to the left of...
    expect(workspaceDropTarget(160).rect?.left).toBe(200);
    // ...and, when appending, the last tab, whose right edge it goes after.
    expect(workspaceDropTarget(900).rect?.right).toBe(300);
    strip(0);
    expect(workspaceDropTarget(10)).toEqual({ index: undefined, rect: null });
  });

  it("finds one Workspace's own tab, and answers null for one not rendered", () => {
    strip(3);
    expect(workspaceTabRect("w1")?.left).toBe(100);
    expect(workspaceTabRect("gone")).toBeNull();
  });
});
