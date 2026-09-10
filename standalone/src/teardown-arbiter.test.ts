import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TauriAdapter } from "./tauri-adapter";

/**
 * The quit flow and the per-window close flow are separate machines over one
 * window, one dialog and one human. Both orderings must leave **no flow stuck
 * and every context settled** (`docs/specs/standalone.md` → "Per-window close",
 * Arbitration).
 *
 * Both real modules are loaded here — that is the point — so the mocks are the
 * union of what each one's own suite needs.
 */
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string) => undefined as unknown),
  listen: vi.fn(),
  countRunningSessions: vi.fn(() => 0),
  hasPendingUpdate: vi.fn(() => false),
  installPendingUpdate: vi.fn(async () => {}),
  archiveSurfaceNotes: vi.fn(async (_ids: readonly string[], _opts?: { signal?: AbortSignal }) => {}),
  notepadSurfaceIds: vi.fn(() => [] as string[]),
  removeSurface: vi.fn(),
  flushWindowSession: vi.fn(async () => {}),
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
vi.mock("dormouse-lib/lib/window-session-aggregator", () => ({
  flushWindowSession: mocks.flushWindowSession,
}));
vi.mock("dormouse-lib/lib/workspace-store", () => ({
  getWorkspacesSnapshot: mocks.getWorkspacesSnapshot,
}));
vi.mock("./updater", () => ({
  hasPendingUpdate: mocks.hasPendingUpdate,
  installPendingUpdate: mocks.installPendingUpdate,
}));

import { initQuitFlow, setQuitConfirmGate, _resetForTesting } from "./quit";
import { initWindowClose, _resetWindowCloseForTesting } from "./window-close";
import { _resetTeardownArbiterForTesting } from "./teardown-flow";
import {
  cancelQuit,
  getQuitConfirmIntent,
  getQuitConfirmPhase,
  openQuitConfirm,
  _resetQuitConfirmForTesting,
} from "./quit-confirm-store";

const listeners = new Map<string, (event: { payload?: unknown }) => void>();
const fire = (event: string, payload?: unknown) => listeners.get(event)?.({ payload });
const quitRequested = (windows = 2) => fire("dormouse://quit-requested", { windows });
const quitCancelled = () => fire("dormouse://quit-cancelled");
const closeRequested = () => fire("dormouse://window-close-requested");
const settle = () => new Promise((r) => setTimeout(r, 0));
const commands = () => mocks.invoke.mock.calls.map((call) => call[0]);
const count = (cmd: string) => commands().filter((name) => name === cmd).length;

function fakeAdapter(): TauriAdapter {
  return {
    captureAgentRecovery: vi.fn(async () => {}),
    requestSessionFlush: vi.fn(async () => {}),
    gracefulKillPtys: vi.fn(async () => {}),
    drainSessionSaves: vi.fn(async () => {}),
  } as unknown as TauriAdapter;
}

describe("one window, two teardown flows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    _resetWindowCloseForTesting();
    _resetTeardownArbiterForTesting();
    _resetQuitConfirmForTesting();
    listeners.clear();
    mocks.listen.mockImplementation((event: string, cb: (e: { payload?: unknown }) => void) => {
      listeners.set(event, cb);
      return Promise.resolve(() => {});
    });
    mocks.countRunningSessions.mockReturnValue(1);
    mocks.hasPendingUpdate.mockReturnValue(false);
    mocks.invoke.mockResolvedValue(undefined);
    mocks.archiveSurfaceNotes.mockResolvedValue(undefined);
    mocks.notepadSurfaceIds.mockReturnValue([]);
    const adapter = fakeAdapter();
    initQuitFlow(adapter);
    initWindowClose(adapter);
    setQuitConfirmGate(openQuitConfirm);
  });

  afterEach(() => {
    setQuitConfirmGate(null);
    _resetTeardownArbiterForTesting();
  });

  it("a quit arriving while a close is confirming takes the dialog over", async () => {
    closeRequested();
    await settle();
    expect(getQuitConfirmIntent().kind).toBe("close-window");

    quitRequested();
    await settle();

    // The close is answered rather than dropped: Rust is holding the window
    // open on a `prevent_close` waiting for exactly this.
    expect(count("window_close_cancel")).toBe(1);
    // …and the quit owns the dialog now.
    expect(getQuitConfirmPhase()).toBe("open");
    expect(getQuitConfirmIntent().kind).toBe("quit");

    // Confirming quits: the flow that took over is the one that runs.
    cancelQuit();
    await settle();
    expect(commands()).toContain("quit_cancel");
    // The close never proceeded.
    expect(commands()).not.toContain("close_window");
  });

  it("a close arriving while a quit is confirming is refused at once", async () => {
    quitRequested();
    await settle();
    expect(getQuitConfirmIntent().kind).toBe("quit");

    closeRequested();
    await settle();

    // Acked, then refused: the window stays and Rust's close watchdog stands
    // down. Never `quit_cancel` — one window's close does not abort the app's
    // quit on behalf of every other window.
    expect(count("window_close_ack")).toBe(1);
    expect(count("window_close_cancel")).toBe(1);
    expect(commands()).not.toContain("quit_cancel");
    // The quit's dialog is untouched, and its context is still live.
    expect(getQuitConfirmPhase()).toBe("open");
    expect(getQuitConfirmIntent().kind).toBe("quit");

    cancelQuit();
    await settle();
    expect(count("quit_cancel")).toBe(1);
  });

  it("another window's cancel drops a quit dialog and never a close one", async () => {
    closeRequested();
    await settle();
    expect(getQuitConfirmIntent().kind).toBe("close-window");

    // A quit cancelled elsewhere says nothing about this window's own close.
    quitCancelled();
    await settle();
    expect(getQuitConfirmPhase()).toBe("open");
    expect(getQuitConfirmIntent().kind).toBe("close-window");

    // …and the close still runs when the user confirms it.
    cancelQuit();
    await settle();
    expect(count("window_close_cancel")).toBe(1);
  });

  it("a quit meeting a committed close votes rather than starting a second teardown", async () => {
    mocks.countRunningSessions.mockReturnValue(0); // no dialog: the close commits
    closeRequested();
    await settle();
    expect(commands()).toContain("close_window");

    quitRequested();
    await settle();

    // Acked, so Rust's ack watchdog stands down, and voted: this window is
    // ending anyway, and a window that never votes leaves the quit machine in
    // `Voting` with no dialog for anyone to answer. Never `quit_cancel`, which
    // would abort the app's quit on behalf of a window already going away.
    expect(commands()).toContain("quit_ack");
    expect(count("quit_vote")).toBe(1);
    expect(commands()).not.toContain("quit_cancel");
    // …and it started no teardown of its own: the close owns the window.
    expect(count("close_window")).toBe(1);
  });

  it("re-asks a quit deferred to a close that then retreated and was cancelled", async () => {
    // The close commits with no dialog and parks inside its archive — committed,
    // and so not something the quit may take the dialog away from.
    mocks.countRunningSessions.mockReturnValue(0);
    mocks.notepadSurfaceIds.mockReturnValue(["pane-a"]);
    let failArchive = (_err: Error) => {};
    mocks.archiveSurfaceNotes.mockReturnValue(
      new Promise<void>((_resolve, reject) => { failArchive = reject; }),
    );
    closeRequested();
    await settle();
    expect(commands()).not.toContain("close_window");

    // The quit takes the committed close as a yes and votes.
    mocks.countRunningSessions.mockReturnValue(1);
    quitRequested();
    await settle();
    expect(count("quit_vote")).toBe(1);

    // The archive fails: the committed close retreats to a question only a
    // human can answer, which is where it can still be talked out of ending.
    failArchive(new Error("the archive is locked"));
    await settle();
    expect(getQuitConfirmPhase()).toBe("archive-failed");

    // The user declines the archive failure: the close is off and the window
    // stays — so the quit's own question, never asked, is asked now.
    cancelQuit();
    await settle();
    expect(count("window_close_cancel")).toBe(1);
    expect(getQuitConfirmPhase()).toBe("open");
    expect(getQuitConfirmIntent().kind).toBe("quit");
    expect(count("quit_ack")).toBe(2);
  });

  it("a refused dialog always settles its context", async () => {
    // The arbiter should keep this from happening at all; the store is the
    // backstop, because an unsettled context parks its flow forever.
    quitRequested();
    await settle();
    const ctx = { confirm: vi.fn(), cancel: vi.fn() };
    openQuitConfirm(ctx, { kind: "close-window" });
    expect(ctx.cancel).toHaveBeenCalledTimes(1);
    expect(ctx.confirm).not.toHaveBeenCalled();
    // …and the standing dialog is untouched.
    expect(getQuitConfirmIntent().kind).toBe("quit");
  });
});
