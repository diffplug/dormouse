import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushWindowSession, installWindowSessionWriter, resetWindowSessionAggregator, seedWindowSession } from "dormouse-lib/lib/window-session-aggregator";
import { withTimeout } from "./with-timeout";
import { TauriSessionStore } from "./tauri-session-store";
import type { PersistedWindow } from "dormouse-lib/lib/session-types";
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
  getWorkspacesSnapshot: vi.fn(() => ({ workspaces: [{ id: "w1", name: "Deploys", nameIsAuto: false }], activeId: "w1" })),
  hasPendingUpdate: vi.fn(() => false),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("dormouse-lib/lib/terminal-registry", () => ({
  countRunningSessions: mocks.countRunningSessions,
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
  getCloseFailure,
  getQuitProgressDetail,
  confirmQuit,
  _resetQuitConfirmForTesting,
} from "./quit-confirm-store";

const listeners = new Map<string, () => void>();
const closeRequested = () => listeners.get("dormouse://window-close-requested")?.();
const settle = () => new Promise((r) => setTimeout(r, 0));
const commands = () => mocks.invoke.mock.calls.map((call) => call[0]);

function fakeAdapter(order: string[] = []): TauriAdapter {
  return {
    gracefulKillPtys: vi.fn(async () => void order.push("gracefulKill")),
    retrySessionSave: vi.fn(),
    drainSessionSaves: vi.fn(async () => void order.push('drain')),
    captureAgentRecovery: vi.fn(async () => void order.push("captureRecovery")),
  } as unknown as TauriAdapter;
}

describe("per-window close", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWindowSessionAggregator();
    _resetWindowCloseForTesting();
    _resetQuitConfirmForTesting();
    listeners.clear();
    mocks.listen.mockImplementation((event: string, cb: () => void) => {
      listeners.set(event, cb);
      return Promise.resolve(() => {});
    });
    mocks.countRunningSessions.mockReturnValue(0);
    mocks.invoke.mockResolvedValue(undefined);
    mocks.hasPendingUpdate.mockReturnValue(false);
  });

  afterEach(() => { _resetWindowCloseForTesting(); resetWindowSessionAggregator(); });

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
    // The dialog says "close", not "quit".
    expect(getQuitConfirmIntent()).toEqual({ kind: "close-window" });
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
    mocks.countRunningSessions.mockReturnValue(0);
    mocks.hasPendingUpdate.mockReturnValue(true);
    const adapter = fakeAdapter();
    initWindowClose(adapter);
    closeRequested();
    await settle();

    expect(getQuitConfirmPhase()).toBe("open");
    expect(getQuitConfirmIntent()).toMatchObject({ kind: "close-window", discardsUpdate: true });
    expect(adapter.gracefulKillPtys).not.toHaveBeenCalled();
  });

  it("says nothing about an update when none is downloaded", async () => {
    mocks.countRunningSessions.mockReturnValue(1);
    initWindowClose(fakeAdapter());
    closeRequested();
    await settle();

    expect(getQuitConfirmIntent().discardsUpdate).toBeUndefined();
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

  it("retains live PTYs after failed snapshot removal and permits a fresh retry", async () => {
    let refusals = 1;
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === 'remove_window_session' && refusals-- > 0) throw new Error('disk full');
      if (cmd === 'retry_window_close') closeRequested();
    });
    const adapter = fakeAdapter();
    initWindowClose(adapter);
    closeRequested();
    await settle();
    expect(getQuitConfirmPhase()).toBe('close-failed');
    expect(getCloseFailure()?.reason).toContain('disk full');
    expect(adapter.gracefulKillPtys).not.toHaveBeenCalled();
    expect(commands()).not.toContain('close_window');
    expect(commands()).toContain('window_close_cancel');
    getCloseFailure()?.retry();
    await settle();
    expect(commands().filter((cmd) => cmd === 'remove_window_session')).toHaveLength(2);
    expect(commands()).toContain('retry_window_close');
    expect(adapter.gracefulKillPtys).toHaveBeenCalledOnce();
    expect(commands()).toContain('close_window');
  });

  it("drains a refused save and republishes unchanged aggregate state after close rollback", async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let rejectRefused!: (error: Error) => void;
      let disk = 'previous';
      let saveCalls = 0;
      const store = new TauriSessionStore(async (value) => {
        if (++saveCalls === 1) await new Promise<void>((_, reject) => { rejectRefused = reject; });
        disk = value;
      });
      store.hydrate(disk);
      const latest: PersistedWindow = { version: 1, activeWorkspaceId: 'w1', workspaces: [
        { id: 'w1', name: 'Deploys', nameIsAuto: false, session: { version: 3, panes: [] } },
      ] };
      seedWindowSession(latest);
      installWindowSessionWriter((snapshot) => store.setItem('state', JSON.stringify(snapshot)));
      await flushWindowSession(); // the native close fence has refused this pending save
      const order: string[] = [];
      mocks.invoke.mockImplementation(async (cmd) => {
        order.push(cmd);
        if (cmd === 'remove_window_session') throw new Error('disk full');
      });
      const adapter = fakeAdapter(order);
      adapter.drainSessionSaves = vi.fn(async () => { order.push('drain'); await store.drain(); });
      adapter.retrySessionSave = () => store.retryLatest();
      initWindowClose(adapter);
      closeRequested();
      await settle();
      expect(order).toEqual(['window_close_ack', 'remove_window_session', 'window_close_cancel', 'drain']);
      expect(saveCalls).toBe(1);
      expect(getQuitConfirmPhase()).toBe('quitting');
      rejectRefused(new Error('window close is holding its snapshot; no session was saved'));
      await settle();
      expect(saveCalls).toBe(2);
      expect(JSON.parse(disk)).toMatchObject(latest);
      expect(adapter.drainSessionSaves).toHaveBeenCalledTimes(2);
      expect(getQuitConfirmPhase()).toBe('close-failed');
      expect(adapter.gracefulKillPtys).not.toHaveBeenCalled();
    } finally { errorLog.mockRestore(); }
  });

  it("retries after a refused save outlives both bounded recovery drains", async () => {
    vi.useFakeTimers();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let rejectFirst!: (error: Error) => void;
      let disk = 'previous';
      let saves = 0;
      const store = new TauriSessionStore(async (value) => {
        if (++saves === 1) await new Promise<void>((_, reject) => { rejectFirst = reject; });
        disk = value;
      });
      store.hydrate(disk);
      seedWindowSession({ version: 1, activeWorkspaceId: 'w1', workspaces: [
        { id: 'w1', name: 'Deploys', nameIsAuto: false, session: { version: 3, panes: [] } },
      ] });
      installWindowSessionWriter((snapshot) => store.setItem('', JSON.stringify(snapshot)));
      await flushWindowSession();
      mocks.invoke.mockImplementation(async (cmd) => {
        if (cmd === 'remove_window_session') throw new Error('disk full');
      });
      const adapter = fakeAdapter();
      adapter.drainSessionSaves = (ms) => withTimeout(store.drain(), ms, 'test drain timeout');
      adapter.retrySessionSave = () => store.retryLatest();
      initWindowClose(adapter);
      closeRequested();
      await vi.advanceTimersByTimeAsync(4001);
      expect(getQuitConfirmPhase()).toBe('close-failed');
      expect(saves).toBe(1);
      expect(disk).toBe('previous');
      rejectFirst(new Error('close refused the earlier write'));
      await vi.advanceTimersByTimeAsync(0);
      expect(saves).toBe(2);
      expect(JSON.parse(disk).workspaces[0].name).toBe('Deploys');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(saves).toBe(2); // one remembered retry, no loop
    } finally { errorLog.mockRestore(); warn.mockRestore(); vi.useRealTimers(); }
  });

  it("keeps the flow guarded if native cancellation does not confirm release", async () => {
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === 'remove_window_session') throw new Error('disk full');
      if (cmd === 'window_close_cancel') throw new Error('native bridge unavailable');
    });
    const adapter = fakeAdapter();
    initWindowClose(adapter);
    closeRequested();
    await settle();
    expect(getQuitConfirmPhase()).toBe('quitting');
    expect(getQuitProgressDetail()).toContain('save refusal could not be released');
    expect(getCloseFailure()).toBeNull();
    expect(adapter.drainSessionSaves).not.toHaveBeenCalled();
    closeRequested();
    await settle();
    expect(commands().filter((cmd) => cmd === 'remove_window_session')).toHaveLength(1);
  });

  it("bounds the aggregate resave without discarding retained live PTYs", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      installWindowSessionWriter(() => new Promise<void>(() => {}));
      mocks.invoke.mockImplementation(async (cmd) => {
        if (cmd === 'remove_window_session') throw new Error('disk full');
      });
      const adapter = fakeAdapter();
      initWindowClose(adapter);
      closeRequested();
      await vi.advanceTimersByTimeAsync(1001);
      expect(getQuitConfirmPhase()).toBe('close-failed');
      expect(adapter.drainSessionSaves).toHaveBeenCalledTimes(2);
      expect(adapter.gracefulKillPtys).not.toHaveBeenCalled();
      expect(commands()).not.toContain('close_window');
    } finally { warn.mockRestore(); vi.useRealTimers(); }
  });

  it("leaves an entered uncertain commit guarded without offering a duplicate close", async () => {
    mocks.invoke.mockImplementation(async (cmd) => {
      if (cmd === 'remove_window_session') throw new Error('close-commit-uncertain: rollback failed');
    });
    const adapter = fakeAdapter();
    initWindowClose(adapter);
    closeRequested();
    await settle();
    expect(getQuitConfirmPhase()).toBe('quitting');
    expect(getQuitProgressDetail()).toContain('rollback failed');
    expect(getCloseFailure()).toBeNull();
    closeRequested();
    await settle();
    expect(commands().filter((cmd) => cmd === 'remove_window_session')).toHaveLength(1);
    expect(commands()).not.toContain('window_close_cancel');
    expect(adapter.drainSessionSaves).not.toHaveBeenCalled();
    expect(adapter.gracefulKillPtys).not.toHaveBeenCalled();
  });

  it("does not time out a human confirmation or an entered native commit", async () => {
    vi.useFakeTimers();
    try {
      mocks.countRunningSessions.mockReturnValue(1);
      let resolveRemoval!: () => void;
      mocks.invoke.mockImplementation((cmd) => cmd === 'remove_window_session'
        ? new Promise<void>((resolve) => { resolveRemoval = resolve; }) : Promise.resolve());
      const adapter = fakeAdapter();
      initWindowClose(adapter);
      closeRequested();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getQuitConfirmPhase()).toBe('open');
      expect(commands()).not.toContain('remove_window_session');
      confirmQuit();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getQuitConfirmPhase()).toBe('quitting');
      expect(adapter.gracefulKillPtys).not.toHaveBeenCalled();
      expect(commands()).not.toContain('close_window');
      resolveRemoval();
      await vi.advanceTimersByTimeAsync(0);
      expect(adapter.gracefulKillPtys).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});
