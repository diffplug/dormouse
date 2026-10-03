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
  needsConfirmation: vi.fn(() => false),
  reopenSnapshot: vi.fn((): unknown => null),
  getWorkspacesSnapshot: vi.fn(() => ({ workspaces: [{ id: "w1", name: "Deploys" }], activeId: "w1" })),
  hasPendingUpdate: vi.fn(() => false),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("dormouse-lib/components/wall/window-reopen", () => ({
  windowNeedsCloseConfirmation: mocks.needsConfirmation,
  windowReopenSnapshot: mocks.reopenSnapshot,
}));


// The Workspaces the dialog names, which the quit-confirm store captures.
vi.mock("dormouse-lib/lib/workspace-store", () => ({
  subscribeToWorkspaces: () => () => {},
  getWorkspacesSnapshot: mocks.getWorkspacesSnapshot,
}));
// Closing a window throws away the download it is holding, so the close asks
// about that too (`docs/specs/auto-update.md` → "Quit-time install").
vi.mock("./updater", () => ({ hasPendingUpdate: mocks.hasPendingUpdate }));

import { initWindowClose, _resetWindowCloseForTesting } from "./window-close";
import {
  cancelQuit as dismissDialog,
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
    mocks.needsConfirmation.mockReturnValue(false);
    mocks.invoke.mockResolvedValue(undefined);
    mocks.hasPendingUpdate.mockReturnValue(false);
    mocks.reopenSnapshot.mockReturnValue(null);
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

  // The webview dies with the close, so the host keeps what Reopen needs
  // (docs/specs/reopen.md); read before the kill empties the Sessions.
  it("hands the host a reopenable window's snapshot before removing and killing", async () => {
    const snapshot = { version: 1, workspaces: [], activeWorkspaceId: "w9" };
    mocks.reopenSnapshot.mockReturnValue(snapshot);
    const order: string[] = [];
    mocks.invoke.mockImplementation(async (cmd: string) => void order.push(cmd));
    initWindowClose(fakeAdapter(order));
    closeRequested();
    await settle();
    expect(order).toEqual(["window_close_ack", "push_closed_window", "remove_window_session", "gracefulKill", "close_window"]);
    expect(mocks.invoke).toHaveBeenCalledWith("push_closed_window", { snapshot: JSON.stringify(snapshot), closedAt: expect.any(Number) });
  });

  it("asks first when the window holds work Reopen cannot restore, and Cancel leaves it alone", async () => {
    mocks.needsConfirmation.mockReturnValue(true);
    const adapter = fakeAdapter();
    initWindowClose(adapter);
    closeRequested();
    await settle();

    expect(getQuitConfirmPhase()).toBe("open");
    // The dialog says "close", not "quit".
    // The dialog says why: Reopen could not bring this window back.
    expect(getQuitConfirmIntent()).toEqual({ kind: "close-window", unreopenable: true });
    expect(adapter.gracefulKillPtys).not.toHaveBeenCalled();

    dismissDialog();
    await settle();
    expect(commands()).toContain("window_close_cancel");
    expect(commands()).not.toContain("close_window");
    expect(adapter.gracefulKillPtys).not.toHaveBeenCalled();
  });

  it("asks about an approved download even with nothing running", async () => {
    // The download lives in this webview's memory, so closing the window is the
    // one ending that silently discards it.
    mocks.needsConfirmation.mockReturnValue(false);
    mocks.hasPendingUpdate.mockReturnValue(true);
    const adapter = fakeAdapter();
    initWindowClose(adapter);
    closeRequested();
    await settle();

    expect(getQuitConfirmPhase()).toBe("open");
    expect(getQuitConfirmIntent()).toEqual({ kind: "close-window", discardsUpdate: true });
    expect(adapter.gracefulKillPtys).not.toHaveBeenCalled();
  });

  it("says nothing about an update when none is downloaded", async () => {
    mocks.needsConfirmation.mockReturnValue(true);
    initWindowClose(fakeAdapter());
    closeRequested();
    await settle();

    expect(getQuitConfirmIntent().discardsUpdate).toBeUndefined();
  });

  it("deduplicates a repeat close trigger while a decision is outstanding", async () => {
    mocks.needsConfirmation.mockReturnValue(true);
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
