import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TauriAdapter } from "./tauri-adapter";

/**
 * Closing one window of several. Mocked exactly like `quit.test.ts`: the Tauri
 * surface plus the two collaborators whose real modules pull the whole lib
 * platform in behind them, so what is observable here is the ordering and the
 * two things a close does that a quit does not — remove the snapshot, and
 * capture no agent recovery.
 */
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string) => undefined as unknown),
  listen: vi.fn(),
  countRunningSessions: vi.fn(() => 0),
  archiveSurfaceNotes: vi.fn(async (_ids: readonly string[], _opts?: { signal?: AbortSignal }) => {}),
  notepadSurfaceIds: vi.fn(() => [] as string[]),
  removeSurface: vi.fn(),
  getWorkspacesSnapshot: vi.fn(() => ({ workspaces: [{ id: "w1", name: "Deploys" }], activeId: "w1" })),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("dormouse-lib/lib/terminal-registry", () => ({
  countRunningSessions: mocks.countRunningSessions,
}));
vi.mock("dormouse-lib/lib/notepad/close-coordinator", () => ({
  archiveSurfaceNotes: mocks.archiveSurfaceNotes,
}));
vi.mock("dormouse-lib/lib/notepad/notepad-store", () => ({
  notepadSurfaceIds: mocks.notepadSurfaceIds,
  removeSurface: mocks.removeSurface,
}));
// How a window names itself in its dialog: the Workspace it is showing.
vi.mock("dormouse-lib/lib/workspace-store", () => ({
  getWorkspacesSnapshot: mocks.getWorkspacesSnapshot,
}));

import { initWindowClose, _resetWindowCloseForTesting } from "./window-close";
import {
  cancelQuit as dismissDialog,
  confirmQuit,
  getQuitArchiveError,
  getQuitConfirmIntent,
  getQuitConfirmPhase,
  _resetQuitConfirmForTesting,
} from "./quit-confirm-store";

const listeners = new Map<string, () => void>();
const closeRequested = () => listeners.get("dormouse://window-close-requested")?.();
const settle = () => new Promise((r) => setTimeout(r, 0));
const commands = () => mocks.invoke.mock.calls.map((call) => call[0]);

function fakeAdapter(order: string[] = []): TauriAdapter {
  return {
    gracefulKillPtys: vi.fn(async () => void order.push("gracefulKill")),
    captureAgentRecovery: vi.fn(async () => void order.push("captureRecovery")),
  } as unknown as TauriAdapter;
}

describe("per-window close", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetWindowCloseForTesting();
    _resetQuitConfirmForTesting();
    listeners.clear();
    mocks.listen.mockImplementation((event: string, cb: () => void) => {
      listeners.set(event, cb);
      return Promise.resolve(() => {});
    });
    mocks.countRunningSessions.mockReturnValue(0);
    mocks.invoke.mockResolvedValue(undefined);
    mocks.archiveSurfaceNotes.mockResolvedValue(undefined);
    mocks.notepadSurfaceIds.mockReturnValue([]);
  });

  afterEach(() => _resetWindowCloseForTesting());

  it("acks, removes the snapshot, kills, and proceeds — with no recovery capture", async () => {
    const order: string[] = [];
    mocks.invoke.mockImplementation(async (cmd: string) => void order.push(cmd));
    const adapter = fakeAdapter(order);
    initWindowClose(adapter);
    closeRequested();
    await settle();

    expect(order).toEqual([
      "window_close_ack",
      // Before the kill: a PTY exit triggers a session save, and the snapshot
      // must not come back after being removed.
      "remove_window_session",
      "gracefulKill",
      "close_window",
    ]);
    // A close is an ending, not a relaunch: there is nothing to resume into.
    expect(adapter.captureAgentRecovery).not.toHaveBeenCalled();
  });

  it("kills only this window's PTYs, naming no ids", async () => {
    const adapter = fakeAdapter();
    initWindowClose(adapter);
    closeRequested();
    await settle();

    // Rust scopes an id-less kill to the invoking window, and a sibling's
    // terminals must not be reachable from here at all.
    expect(adapter.gracefulKillPtys).toHaveBeenCalledWith(expect.any(Number));
  });

  it("asks first when the window holds running work, and Cancel leaves it alone", async () => {
    mocks.countRunningSessions.mockReturnValue(2);
    const adapter = fakeAdapter();
    initWindowClose(adapter);
    closeRequested();
    await settle();

    expect(getQuitConfirmPhase()).toBe("open");
    // The dialog says "close", not "quit", and names the window.
    expect(getQuitConfirmIntent()).toEqual({ kind: "close-window", windowName: "Deploys" });
    expect(adapter.gracefulKillPtys).not.toHaveBeenCalled();

    dismissDialog();
    await settle();
    expect(commands()).toContain("window_close_cancel");
    expect(commands()).not.toContain("close_window");
    expect(adapter.gracefulKillPtys).not.toHaveBeenCalled();
  });

  it("archives every Surface holding notes, because a close is deliberate", async () => {
    mocks.notepadSurfaceIds.mockReturnValue(["pane-a"]);
    const order: string[] = [];
    mocks.invoke.mockImplementation(async (cmd: string) => void order.push(cmd));
    mocks.archiveSurfaceNotes.mockImplementation(async () => void order.push("archive"));

    initWindowClose(fakeAdapter(order));
    closeRequested();
    await settle();

    expect(order.slice(0, 3)).toEqual(["window_close_ack", "archive", "remove_window_session"]);
    expect(mocks.archiveSurfaceNotes).toHaveBeenCalledWith(["pane-a"], expect.anything());
  });

  it("holds the close open when the archive refuses, and Close anyway discards the notes", async () => {
    mocks.notepadSurfaceIds.mockReturnValue(["pane-a"]);
    mocks.archiveSurfaceNotes.mockRejectedValue(new Error("disk is full"));
    const adapter = fakeAdapter();
    initWindowClose(adapter);
    closeRequested();
    await settle();

    expect(getQuitConfirmPhase()).toBe("archive-failed");
    expect(getQuitArchiveError()).toBe("disk is full");
    expect(getQuitConfirmIntent().kind).toBe("close-window");
    expect(commands()).not.toContain("window_close_cancel");
    expect(adapter.gracefulKillPtys).not.toHaveBeenCalled();

    confirmQuit();
    await settle();
    expect(mocks.removeSurface).toHaveBeenCalledWith("pane-a");
    expect(commands()).toContain("close_window");
  });

  it("deduplicates a repeat close trigger while a decision is outstanding", async () => {
    mocks.countRunningSessions.mockReturnValue(1);
    initWindowClose(fakeAdapter());
    closeRequested();
    await settle();
    closeRequested();
    await settle();

    // Acked twice (Rust's watchdog stands down each time) but asked once.
    expect(commands().filter((cmd) => cmd === "window_close_ack")).toHaveLength(2);
    expect(getQuitConfirmPhase()).toBe("open");
  });

  it("closes anyway when a teardown step rejects", async () => {
    const adapter = {
      gracefulKillPtys: vi.fn(async () => { throw new Error("SIGTERM refused"); }),
    } as unknown as TauriAdapter;
    initWindowClose(adapter);
    closeRequested();
    await settle();

    expect(commands()).toContain("close_window");
  });
});
