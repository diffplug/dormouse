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
vi.mock("@xterm/addon-unicode-graphemes", () => ({ UnicodeGraphemesAddon: class {} }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    parser = { registerCsiHandler: () => ({ dispose: () => {} }) };
    modes = { mouseTrackingMode: "none" as const, bracketedPasteMode: false };
    loadAddon(): void {}
    open(): void {}
    write(): void {}
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
} from "./workspace-move";
import { workspaceDropTarget, workspaceTabRect } from "./workspace-tabs";
import { registerWallHandle, resetWallHandles, stubWallHandle } from "dormouse-lib/components/wall/wall-handles";
import {
  getWorkspaceBootPlan,
  resetWorkspaceBootPlans,
} from "dormouse-lib/components/wall/workspace-boot-plans";
import { getWorkspacesSnapshot, resetWorkspaces } from "dormouse-lib/lib/workspace-store";
import { getNotes, clearAllNotepads } from "dormouse-lib/lib/notepad/notepad-store";
import { resetWindowSessionAggregator } from "dormouse-lib/lib/window-session-aggregator";
import { setPlatform } from "dormouse-lib/lib/platform";
import { FakePtyAdapter } from "dormouse-lib/lib/platform/fake-adapter";

const WORKSPACE_ID = "ws-moving";

/** Drain the microtask chain the arrival drain runs on. */
const settle = () => new Promise((r) => setTimeout(r, 0));

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

/** What `take_arrivals` answers: what Rust is holding for this window. */
let queuedArrivals: WorkspaceTransferPayload[] = [];

/** A prepared transfer whose commit is observable. */
function prepared(
  onCommit: () => void = () => {},
  overrides: Partial<WorkspaceTransferPayload> = {},
): PreparedWorkspaceTransfer {
  return { payload: payload(overrides), commit: onCommit };
}

/**
 * A real adapter whose `pty:list` / `pty:replay` answer only once something
 * asks — which is the property the `adopt_ready` hop exists to guarantee.
 */
function fakePlatform(order: string[] = [], opts: { answer?: boolean } = {}): PlatformAdapter {
  const platform = new FakePtyAdapter();
  let listHandler: ((detail: { ptys: PtyInfo[]; requestId?: string }) => void) | null = null;
  let replayHandler: ((detail: { id: string; data: string; requestId?: string }) => void) | null = null;
  vi.spyOn(platform, "onPtyList").mockImplementation((handler) => { listHandler = handler; });
  vi.spyOn(platform, "offPtyList").mockImplementation(() => { listHandler = null; });
  vi.spyOn(platform, "onPtyReplay").mockImplementation((handler) => { replayHandler = handler; });
  vi.spyOn(platform, "offPtyReplay").mockImplementation(() => { replayHandler = null; });
  vi.spyOn(platform, "requestInit").mockImplementation(() => {
    throw new Error("an arrival must never ask for the whole Window");
  });
  // The fake adapter has no AlertManager, so give it the optional hook the
  // arrival seeds a persisted TODO through.
  (platform as unknown as { alertSeed: unknown }).alertSeed = vi.fn();
  mocks.invoke.mockImplementation(async (cmd: string, args?: unknown) => {
    order.push(cmd);
    if (cmd === "take_arrivals") return queuedArrivals.splice(0, queuedArrivals.length);
    if (cmd === "adopt_ready" && opts.answer !== false) {
      order.push("answered");
      // The host echoes the collector's own token: two arrivals at once must
      // not finish on each other's list.
      const requestId = (args as { requestId?: string } | undefined)?.requestId;
      listHandler?.({ ptys: [{ id: "pane-a", alive: true } as PtyInfo], requestId });
      replayHandler?.({ id: "pane-a", data: "scrollback", requestId });
    }
    return undefined;
  });
  setPlatform(platform);
  return platform;
}

beforeEach(() => {
  vi.clearAllMocks();
  queuedArrivals = [];
  mocks.invoke.mockResolvedValue(undefined);
  mocks.listen.mockResolvedValue(() => {});
  resetWallHandles();
  resetWorkspaceBootPlans();
  resetWorkspaces();
  resetWindowSessionAggregator();
  clearAllNotepads();
});

describe("the source half", () => {
  it("prepares the Workspace, tells the host, and releases it only once", async () => {
    const order: string[] = [];
    mocks.invoke.mockImplementation(async (cmd: string) => void order.push(cmd));
    registerWallHandle(stubWallHandle(WORKSPACE_ID, {
      prepareWorkspaceTransfer: async () => {
        order.push("prepare");
        return prepared(() => order.push("commit"));
      },
    }));

    await transferWorkspaceTo(WORKSPACE_ID, "ws-2", { x: 10, y: 4 });

    // The record is built while the Sessions are live, and detached only after
    // Rust has taken ownership.
    expect(order).toEqual(["prepare", "transfer_workspace", "commit"]);
    const [, args] = mocks.invoke.mock.calls[0]!;
    expect(args).toMatchObject({ to: "ws-2", payload: { at: { x: 10, y: 4 }, terminalIds: ["pane-a"] } });
  });

  it("leaves the source Workspace intact when the host refuses", async () => {
    // The target window can close between the drag's last probe and the drop.
    // Releasing first would leave a Workspace with no Sessions and no window
    // that owns them.
    mocks.invoke.mockRejectedValue(new Error("no window 'ws-2'"));
    const committed = vi.fn();
    registerWallHandle(stubWallHandle(WORKSPACE_ID, {
      prepareWorkspaceTransfer: async () => prepared(committed),
    }));

    await transferWorkspaceTo(WORKSPACE_ID, "ws-2", { x: 10, y: 4 });

    expect(committed).not.toHaveBeenCalled();
  });

  it("leaves the source Workspace intact when the tear-out cannot build a window", async () => {
    mocks.invoke.mockRejectedValue(new Error("build window ws-3: no display"));
    const committed = vi.fn();
    registerWallHandle(stubWallHandle(WORKSPACE_ID, {
      prepareWorkspaceTransfer: async () => prepared(committed),
    }));

    await tearOutWorkspace(WORKSPACE_ID, { x: 90, y: 12 });

    expect(committed).not.toHaveBeenCalled();
  });

  it("tears out into a new window carrying the tab's grab offset", async () => {
    registerWallHandle(stubWallHandle(WORKSPACE_ID, { prepareWorkspaceTransfer: async () => prepared() }));
    // Only Rust knows where the cursor is on screen, so the payload carries
    // where the tab should sit inside the new window rather than a position.
    await tearOutWorkspace(WORKSPACE_ID, { x: 90, y: 12 });
    expect(mocks.invoke).toHaveBeenCalledWith("open_workspace_window", {
      payload: expect.objectContaining({ grab: { x: 90, y: 12 } }),
    });
  });

  it("does nothing when the Workspace has no mounted Wall", async () => {
    await transferWorkspaceTo("gone", "ws-2", { x: 0, y: 0 });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("the target half", () => {
  /** Fire the listener `initWorkspaceMoves` registered for `event`. */
  const emit = async (event: string, data: unknown) => {
    const calls = mocks.listen.mock.calls as unknown as Array<[string, (e: { payload: unknown }) => void]>;
    calls.find(([name]) => name === event)![1]({ payload: data });
    await new Promise((r) => setTimeout(r, 0));
  };

  it("arms its collector, then asks — and mounts the Workspace it gets back", async () => {
    const order: string[] = [];
    const platform = fakePlatform(order);
    queuedArrivals = [payload()];
    initWorkspaceMoves(platform);
    await settle();

    // The `adopt_ready` hop is what removes the "arrived before armed" bug
    // class: nothing is listed or replayed until the collector is listening.
    expect(order).toEqual(["take_arrivals", "adopt_ready", "answered"]);
    // The plan is parked before the Workspace exists, because creating it
    // mounts the Wall that reads it.
    expect(getWorkspaceBootPlan(WORKSPACE_ID)).toBeTruthy();
    const { workspaces, activeId } = getWorkspacesSnapshot();
    expect(workspaces.map((workspace) => workspace.name)).toContain("Deploys");
    expect(activeId).toBe(WORKSPACE_ID);
    // The notes travelled in the payload; nothing was archived.
    expect(getNotes("pane-a").map((note) => note.content)).toEqual([{ kind: "plain", text: "keep me" }]);
  });

  it("seeds a persisted TODO into this window's own AlertManager", async () => {
    const platform = fakePlatform();
    const alert = { kind: "todo" } as never;
    const moving = payload();
    moving.workspace.session.panes[0]!.alert = alert;
    queuedArrivals = [moving];

    initWorkspaceMoves(platform);
    await settle();

    expect(platform.alertSeed).toHaveBeenCalledWith("pane-a", alert);
  });

  it("takes an arrival that was queued before its listener existed", async () => {
    // A window still booting — or torn out moments ago — is a legal drop
    // target, and an `emit_to` it reaches nothing. The payload waits in Rust.
    const platform = fakePlatform();
    queuedArrivals = [payload()];

    initWorkspaceMoves(platform);
    await settle();

    expect(getWorkspacesSnapshot().workspaces.map((w) => w.name)).toContain("Deploys");
  });

  it("mounts nothing when the host never answers, rather than restarting live shells", async () => {
    // A timed-out collection is not a collection that found no PTYs: those
    // shells are still running, and a cold restore would start a second set.
    vi.useFakeTimers();
    try {
      const platform = fakePlatform([], { answer: false });
      queuedArrivals = [payload()];
      initWorkspaceMoves(platform);
      await vi.advanceTimersByTimeAsync(5000);

      expect(getWorkspacesSnapshot().workspaces.map((w) => w.name)).not.toContain("Deploys");
      expect(getWorkspaceBootPlan(WORKSPACE_ID)).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes the window when its last Workspace leaves, instead of emptying it", async () => {
    initWorkspaceMoves(fakePlatform());
    mocks.invoke.mockImplementation(async () => undefined);

    await emit("dormouse://workspace-departed", { workspaceId: getWorkspacesSnapshot().activeId });

    // Nothing ended — the Surfaces are alive in another window — so this is a
    // close with no confirmation, no archive and no kill.
    expect(mocks.invoke).toHaveBeenCalledWith("close_window");
    expect(getWorkspacesSnapshot().workspaces).toHaveLength(1);
  });
});

describe("a torn-out window's boot", () => {
  it("boots from the queued payload rather than from disk", async () => {
    const order: string[] = [];
    queuedArrivals = [payload()];
    const platform = fakePlatform(order);

    const plans = await bootFromTearOut(platform);

    expect(order.slice(0, 2)).toEqual(["take_arrivals", "adopt_ready"]);
    expect(Object.keys(plans ?? {})).toEqual([WORKSPACE_ID]);
    // The window has no snapshot yet; its Workspace comes from the payload.
    expect(getWorkspacesSnapshot().workspaces.map((workspace) => workspace.name)).toEqual(["Deploys"]);
    expect(getNotes("pane-a")).toHaveLength(1);
  });

  it("returns null for an ordinary window", async () => {
    const platform = fakePlatform();
    expect(await bootFromTearOut(platform)).toBeNull();
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
