import { beforeEach, describe, expect, it, vi } from "vitest";

// The planner is pure routing over the live PTY list; standing up real xterm
// hosts for it needs a browser. Mocked exactly as `lib/src/lib/reconnect.test.ts`
// does, so what stays real is the slicing and the helper store.
const registryMocks = vi.hoisted(() => ({
  restoreBrowserSurfaceTodo: vi.fn(),
  resumeTerminal: vi.fn(),
  restoreTerminal: vi.fn(),
  getDefaultShellOpts: vi.fn(() => null),
}));
vi.mock("dormouse-lib/lib/terminal-registry", () => registryMocks);

import type { PlatformAdapter, PtyInfo } from "dormouse-lib/lib/platform/types";
import { DEFAULT_WORKSPACE_ID } from "dormouse-lib/lib/session-types";
import type { PersistedSession, PersistedWindow } from "dormouse-lib/lib/session-types";
import { forgetHelper, getHelper } from "dormouse-lib/lib/helper-terminal";
import { setPlatform } from "dormouse-lib/lib/platform";
import { getWorkspacesSnapshot, resetWorkspaces } from "dormouse-lib/lib/workspace-store";
import { resetWindowSessionAggregator } from "dormouse-lib/lib/window-session-aggregator";
import type { LathNode } from "dormouse-lib/lib/lath/model";
import { restoreWindowOrFresh, routeUnownedPtys } from "./window-restore";

/** A native Lath layout over `ids` — what every post-Lath save carries. */
function lathLayoutFor(...ids: string[]) {
  const nodes = ids.map((id): LathNode => ({ kind: "leaf", id }));
  const root: LathNode | null =
    nodes.length === 0
      ? null
      : nodes.length === 1
        ? nodes[0]
        : { kind: "split", dir: "row", children: nodes.map((node) => ({ node, weight: 1 / nodes.length })) };
  return {
    version: 1 as const,
    tree: { root },
    leafMeta: Object.fromEntries(
      ids.map((id) => [id, { component: "terminal", tabComponent: "terminal", title: id }]),
    ),
  };
}

const sessionOver = (...ids: string[]): PersistedSession => ({
  version: 3,
  lathLayout: lathLayoutFor(...ids),
  panes: ids.map((id) => ({ id, title: id, cwd: null, untouched: false })),
});

/** Enough adapter for the boot path: the PTY list handshake plus the Window slot. */
function fakePlatform(ptys: PtyInfo[], saved: PersistedWindow | null) {
  const listHandlers = new Set<(detail: { ptys: PtyInfo[] }) => void>();
  const replayHandlers = new Set<(detail: { id: string; data: string }) => void>();
  const saves: PersistedWindow[] = [];
  const platform = {
    recoveryReady: Promise.resolve(),
    getRecoveryCommands: () => ({}),
    getState: () => null,
    saveState: vi.fn(),
    getWindowState: () => saved,
    saveWindowState: (snapshot: PersistedWindow) => { saves.push(snapshot); },
    requestInit: () => {
      for (const handler of listHandlers) handler({ ptys });
      for (const pty of ptys) for (const handler of replayHandlers) handler({ id: pty.id, data: "" });
    },
    onPtyList: (handler: (detail: { ptys: PtyInfo[] }) => void) => { listHandlers.add(handler); },
    offPtyList: (handler: (detail: { ptys: PtyInfo[] }) => void) => { listHandlers.delete(handler); },
    onPtyReplay: (handler: (detail: { id: string; data: string }) => void) => { replayHandlers.add(handler); },
    offPtyReplay: (handler: (detail: { id: string; data: string }) => void) => { replayHandlers.delete(handler); },
    spawnPty: vi.fn(),
    killPty: vi.fn(),
    alertSeed: vi.fn(),
  } as unknown as PlatformAdapter;
  setPlatform(platform);
  return { platform, saves };
}

beforeEach(() => {
  resetWindowSessionAggregator();
  resetWorkspaces();
});

describe("routeUnownedPtys", () => {
  it("routes a helper to the Workspace holding its source, not the active one", () => {
    const saved: PersistedWindow = {
      version: 1,
      workspaces: [
        { id: "ws-a", name: "A", session: sessionOver("a1") },
        { id: "ws-b", name: "B", session: sessionOver("b1") },
      ],
      activeWorkspaceId: "ws-a",
    };
    const ptys: PtyInfo[] = [
      { id: "a1", alive: true },
      { id: "b1", alive: true },
      { id: "h1", alive: true, helper: { parentId: "b1", command: "git status" } },
    ];

    const { extra, unowned } = routeUnownedPtys(ptys, saved);

    expect([...(extra.get("ws-b") ?? [])]).toEqual(["h1"]);
    expect(extra.has("ws-a")).toBe(false);
    expect([...unowned]).toEqual([]);
  });

  it("leaves a helper whose source is itself unowned to the active Workspace", () => {
    const saved: PersistedWindow = {
      version: 1,
      workspaces: [{ id: "ws-a", name: "A", session: sessionOver("a1") }],
      activeWorkspaceId: "ws-a",
    };
    const ptys: PtyInfo[] = [
      { id: "fresh", alive: true },
      { id: "h1", alive: true, helper: { parentId: "fresh", command: "git status" } },
    ];

    const { extra, unowned } = routeUnownedPtys(ptys, saved);

    expect(extra.size).toBe(0);
    expect([...unowned].sort()).toEqual(["fresh", "h1"]);
  });
});

describe("restoreWindowOrFresh", () => {
  it("keeps B's helper in B and leaves A's layout intact", async () => {
    // The bug this pins: every helper is unowned by name, so routing them all to
    // the active Workspace promoted B's helper to a top-level pane of A, and its
    // stray id then voided A's whole saved layout.
    const saved: PersistedWindow = {
      version: 1,
      workspaces: [
        { id: "ws-a", name: "A", session: sessionOver("a1", "a2") },
        { id: "ws-b", name: "B", session: sessionOver("b1") },
      ],
      activeWorkspaceId: "ws-a",
    };
    const helper = { parentId: "b1", command: "git status" };
    const { platform } = fakePlatform(
      [
        { id: "a1", alive: true },
        { id: "a2", alive: true },
        { id: "b1", alive: true },
        { id: "h1", alive: true, helper },
      ],
      saved,
    );

    const plans = await restoreWindowOrFresh(platform);

    expect(plans["ws-a"].initialPaneIds).toEqual(["a1", "a2"]);
    expect(plans["ws-a"].restoredLathLayout).toEqual(saved.workspaces[0].session.lathLayout);
    expect(plans["ws-b"].initialPaneIds).toEqual(["b1"]);
    expect(plans["ws-b"].restoredLathLayout).toEqual(saved.workspaces[1].session.lathLayout);
    // The helper is restored as one — parked beside its source, not a pane.
    expect(getHelper("b1")?.status).toBe("preserved");
    forgetHelper("b1");
  });

  it("boots a fresh Window and rewrites the blob when the restore throws", async () => {
    // A duplicate Workspace id is rejected outright by `setWorkspaces`; before,
    // the throw escaped `bootstrap()` and nothing rendered at all — on this and
    // every later launch.
    const duplicated: PersistedWindow = {
      version: 1,
      workspaces: [
        { id: "ws-a", name: "A", session: sessionOver("a1") },
        { id: "ws-a", name: "A again", session: sessionOver("a2") },
      ],
      activeWorkspaceId: "ws-a",
    };
    const { platform, saves } = fakePlatform([], duplicated);

    const plans = await restoreWindowOrFresh(platform);

    // One freshly minted Workspace, planned and renderable.
    const [id] = getWorkspacesSnapshot().workspaces.map((workspace) => workspace.id);
    expect(Object.keys(plans)).toEqual([id]);
    expect(getWorkspacesSnapshot().workspaces).toHaveLength(1);
    // And the blob that could not be restored is gone.
    expect(saves[saves.length - 1]?.workspaces).toEqual([]);
  });

  it("mints a unique first Workspace id for every fresh Window", async () => {
    // Two windows that both started fresh must not both hold `workspace-1`:
    // each writes its own blob, and a relaunch would then meet the same
    // Workspace id twice and refuse the whole restore.
    const first = fakePlatform([], null);
    const firstPlans = await restoreWindowOrFresh(first.platform);
    const firstId = getWorkspacesSnapshot().workspaces[0].id;

    resetWorkspaces();
    resetWindowSessionAggregator();
    const second = fakePlatform([], null);
    const secondPlans = await restoreWindowOrFresh(second.platform);
    const secondId = getWorkspacesSnapshot().workspaces[0].id;

    expect(Object.keys(firstPlans)).toEqual([firstId]);
    expect(Object.keys(secondPlans)).toEqual([secondId]);
    expect(firstId).not.toBe(secondId);
    expect(firstId).not.toBe(DEFAULT_WORKSPACE_ID);
  });
});
