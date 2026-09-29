import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TauriAdapter } from "./tauri-adapter";

// The orchestrator is pure webview-side glue: it listens for one Rust event,
// calls adapter/updater primitives, and invokes three Rust commands. Mock the
// Tauri surface (core invoke + event listen) like updater.test.ts, plus the two
// collaborators (countRunningSessions, the updater install pair) so ordering is
// observable. The adapter is injected into initQuitFlow, so it needs no module
// mock. quit.ts imports TauriAdapter as a type only (erased) — no runtime dep.
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string) => undefined as unknown),
  listen: vi.fn(),
  countRunningSessions: vi.fn(() => 0),
  hasPendingUpdate: vi.fn(() => false),
  installPendingUpdate: vi.fn(async () => {}),
  flushWindowSession: vi.fn(async () => {}),
  getWorkspacesSnapshot: vi.fn(() => ({ workspaces: [{ id: "w1", name: "Deploys" }], activeId: "w1" })),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("dormouse-lib/lib/terminal-registry", () => ({
  countRunningSessions: mocks.countRunningSessions,
}));
// The Rust command the close path removes a snapshot with; the quit path never
// calls it (a quit keeps every window's blob, which is what a relaunch reads).

// The aggregator's write step. Mocked for the same reason as the registry: what
// this file tests is where it sits in the order.
vi.mock("dormouse-lib/lib/window-session-aggregator", () => ({
  flushWindowSession: mocks.flushWindowSession,
}));
// The Workspaces the dialog names, which the quit-confirm store captures.
vi.mock("dormouse-lib/lib/workspace-store", () => ({
  subscribeToWorkspaces: () => () => {},
  getWorkspacesSnapshot: mocks.getWorkspacesSnapshot,
}));
vi.mock("./updater", () => ({
  hasPendingUpdate: mocks.hasPendingUpdate,
  installPendingUpdate: mocks.installPendingUpdate,
}));

import { initQuitFlow, setQuitConfirmGate, _resetForTesting } from "./quit";
import {
  getQuitConfirmPhase,
  openQuitConfirm,
  _resetQuitConfirmForTesting,
} from "./quit-confirm-store";

// The captured Rust event listeners, keyed by event name. Rust asks every
// window to vote (`quit-requested`), tells them all when someone declines
// (`quit-cancelled`), and walks them one at a time (`quit-teardown`).
const listeners = new Map<string, (event: { payload?: unknown }) => void>();
const fire = (event: string, payload?: unknown) => listeners.get(event)?.({ payload });
const quitRequested = () => fire("dormouse://quit-requested", { requester: null });
const quitTeardown = (last = true) => fire("dormouse://quit-teardown", { last });
const quitCancelled = () => fire("dormouse://quit-cancelled");
const voted = () => mocks.invoke.mock.calls.some((call) => call[0] === "quit_vote");

// Drain the microtask-driven teardown chain (no real timers on the happy path —
// withTimeout's ceiling guard is cleared when the work wins).
const settle = () => new Promise((r) => setTimeout(r, 0));

// A fake adapter whose teardown steps append their name to `order` so the call
// sequence is assertable. `overrides` swap in slow/failing steps per test.
function fakeAdapter(order: string[] = [], overrides: Partial<Record<string, () => Promise<void>>> = {}): TauriAdapter {
  const step = (name: string) =>
    vi.fn(async () => {
      if (overrides[name]) return overrides[name]!();
      order.push(name);
    });
  return {
    captureAgentRecovery: step("captureRecovery"),
    requestSessionFlush: step("flush"),
    gracefulKillPtys: step("gracefulKill"),
    drainSessionSaves: step("drain"),
  } as unknown as TauriAdapter;
}

/**
 * Wire the orchestrator, ask this window to vote, and — once it has — run the
 * walk's teardown for it. `last` is what the walk hands the final window
 * (`main`), which installs and exits; every other one is destroyed instead.
 */
async function triggerQuit(
  adapter: TauriAdapter,
  { last = true }: { last?: boolean } = {},
): Promise<void> {
  initQuitFlow(adapter);
  quitRequested();
  await settle();
  if (!voted()) return;
  quitTeardown(last);
  await settle();
}

describe("quit orchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    _resetQuitConfirmForTesting();
    listeners.clear();
    mocks.listen.mockImplementation((event: string, cb: (e: { payload?: unknown }) => void) => {
      listeners.set(event, cb);
      return Promise.resolve(() => {});
    });
    mocks.countRunningSessions.mockReturnValue(0);
    mocks.hasPendingUpdate.mockReturnValue(false);
    mocks.installPendingUpdate.mockResolvedValue(undefined);
    mocks.invoke.mockResolvedValue(undefined);
    mocks.flushWindowSession.mockResolvedValue(undefined);
  });

  afterEach(() => setQuitConfirmGate(null));

  it("always acks the quit-requested event", async () => {
    await triggerQuit(fakeAdapter());

    expect(mocks.invoke).toHaveBeenCalledWith("quit_ack");
  });

  it("with no running sessions, tears down immediately and proceeds", async () => {
    const adapter = fakeAdapter();
    await triggerQuit(adapter);

    expect(adapter.requestSessionFlush).toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith("quit_proceed");
  });

  it("runs teardown steps capture → flush → kill → flush → window → drain → install → proceed in order", async () => {
    const order: string[] = [];
    mocks.invoke.mockImplementation(async (cmd: string) => {
      order.push(cmd);
      return undefined;
    });
    mocks.flushWindowSession.mockImplementation(async () => {
      order.push("flushWindow");
    });
    mocks.hasPendingUpdate.mockReturnValue(true);
    mocks.installPendingUpdate.mockImplementation(async () => {
      order.push("install");
    });

    await triggerQuit(fakeAdapter(order));

    // The capture is first: an agent's resume invocation exists only between the
    // interrupt and the kill. `quit_progress` marks each phase boundary (teardown
    // start, install start) so Rust's watchdog budgets them separately.
    expect(order).toEqual([
      "quit_ack",
      "quit_vote",
      "quit_progress",
      "captureRecovery",
      "flush",
      "gracefulKill",
      "flush",
      "flushWindow",
      "drain",
      "quit_progress",
      "install",
      "quit_proceed",
    ]);
  });

  it("finishes the final save when every step takes its worst-case time", async () => {
    // The webview-observable worst case of each step: the two that reach the
    // sidecar wait Rust's round-trip margin on top of their own budget. A
    // ceiling below the sum of these aborts exactly the last steps — the final
    // save — so `drain` must still land before the exit.
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      mocks.invoke.mockImplementation(async (cmd: string) => {
        order.push(cmd);
        return undefined;
      });
      const slow = (name: string, ms: number) => () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            order.push(name);
            resolve();
          }, ms);
        });
      const adapter = fakeAdapter(order, {
        captureRecovery: slow("captureRecovery", 1300 + 1500),
        flush: slow("flush", 1500),
        gracefulKill: slow("gracefulKill", 2000 + 1500),
        drain: slow("drain", 2000),
      });
      mocks.flushWindowSession.mockImplementation(slow("flushWindow", 999));

      initQuitFlow(adapter);
      quitRequested();
      await vi.advanceTimersByTimeAsync(0);
      quitTeardown();
      await vi.advanceTimersByTimeAsync(30_000);

      expect(order).toContain("flushWindow");
      expect(order).toContain("drain");
      expect(order.indexOf("drain")).toBeLessThan(order.indexOf("quit_proceed"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a wedged Window write so the drain behind it still runs", async () => {
    // Both standalone writers are synchronous today, so this step never waits;
    // but it is bounded on what the writer may return, not on what it happens
    // to be — a writer that never settles must cost its own budget, not the
    // ceiling's slack and then the drain.
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      mocks.invoke.mockImplementation(async (cmd: string) => {
        order.push(cmd);
        return undefined;
      });
      mocks.flushWindowSession.mockReturnValue(new Promise<void>(() => {})); // never settles
      const adapter = fakeAdapter(order);

      initQuitFlow(adapter);
      quitRequested();
      await vi.advanceTimersByTimeAsync(0);
      // Voted; Rust walks this window, and the wedged write must not hold the
      // drain behind it past its own budget.
      quitTeardown();
      await vi.advanceTimersByTimeAsync(1000);

      expect(order.slice(-2)).toEqual(["drain", "quit_proceed"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still saves and exits when the recovery capture rejects", async () => {
    // Recovery is the one step whose data cannot be reconstructed, but losing it
    // must never cost the save behind it.
    const order: string[] = [];
    const adapter = fakeAdapter(order, {
      captureRecovery: () => Promise.reject(new Error("sidecar gone")),
    });
    await triggerQuit(adapter);

    expect(order).toEqual(["flush", "gracefulKill", "flush", "drain"]);
    expect(mocks.flushWindowSession).toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith("quit_proceed");
  });

  it("skips install and its phase signal when no update is pending", async () => {
    mocks.hasPendingUpdate.mockReturnValue(false);
    await triggerQuit(fakeAdapter());

    expect(mocks.installPendingUpdate).not.toHaveBeenCalled();
    // Exactly one phase signal: teardown began, but there is no install phase.
    const progress = mocks.invoke.mock.calls.filter((c) => c[0] === "quit_progress").length;
    expect(progress).toBe(1);
    expect(mocks.invoke).toHaveBeenCalledWith("quit_proceed");
  });

  it("emits no teardown phase signal while a confirmation is pending", async () => {
    // The confirmation wait must not look like teardown progress to Rust, or its
    // watchdog would start the teardown clock against a human decision.
    mocks.countRunningSessions.mockReturnValue(1);
    const adapter = fakeAdapter();
    setQuitConfirmGate(vi.fn()); // gate never decides — dialog stays up

    await triggerQuit(adapter);

    // Not even a vote: a window parked on its dialog has not decided, and a
    // vote is what would let the walk start destroying the others.
    expect(mocks.invoke).not.toHaveBeenCalledWith("quit_vote");
    expect(mocks.invoke).not.toHaveBeenCalledWith("quit_progress");
    expect(mocks.invoke).toHaveBeenCalledWith("quit_ack");
  });

  it("still proceeds when a teardown step rejects", async () => {
    const adapter = fakeAdapter([], {
      gracefulKill: () => Promise.reject(new Error("SIGTERM refused")),
    });
    await triggerQuit(adapter);

    // A rejecting step must not prevent exit.
    expect(mocks.invoke).toHaveBeenCalledWith("quit_proceed");
  });

  it("ignores a second quit-requested while teardown is running", async () => {
    // Park only the FIRST flush (step 1) so the teardown stays in flight across
    // the 2nd trigger; step 3's flush resolves so the teardown can complete.
    let release!: () => void;
    let flushCount = 0;
    const adapter = fakeAdapter([], {
      flush: () => {
        flushCount += 1;
        if (flushCount === 1) return new Promise<void>((r) => { release = r; });
        return Promise.resolve();
      },
    });
    initQuitFlow(adapter);

    quitRequested();
    await settle();
    quitTeardown(); // starts teardown; parked at the first flush
    await settle();
    quitRequested(); // repeat trigger — must not restart teardown
    await settle();

    // Only one teardown ran: the first flush was entered exactly once.
    expect(adapter.requestSessionFlush).toHaveBeenCalledTimes(1);
    // But both triggers still acked (Rust's watchdog stands down each time).
    const acks = mocks.invoke.mock.calls.filter((c) => c[0] === "quit_ack").length;
    expect(acks).toBe(2);

    release();
    await settle();
    expect(mocks.invoke).toHaveBeenCalledWith("quit_proceed");
  });

  it("routes a running-session quit through an installed confirm gate", async () => {
    mocks.countRunningSessions.mockReturnValue(3);
    const adapter = fakeAdapter();
    // Simulate the user confirming.
    const gate = vi.fn((ctx) => ctx.confirm());
    setQuitConfirmGate(gate);

    await triggerQuit(adapter);

    expect(gate).toHaveBeenCalledTimes(1);
    expect(adapter.requestSessionFlush).toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith("quit_proceed");
  });

  it("hands the gate the requester Rust sent, and leaves it out of the count", async () => {
    mocks.countRunningSessions.mockReturnValue(1);
    const gate = vi.fn();
    setQuitConfirmGate(gate);
    initQuitFlow(fakeAdapter());

    fire("dormouse://quit-requested", { requester: "pane-7" });
    expect(gate).toHaveBeenLastCalledWith(expect.anything(), { kind: "quit", requester: "pane-7" });
    expect(mocks.countRunningSessions).toHaveBeenLastCalledWith("pane-7");

    quitCancelled();
    quitRequested();
    expect(gate).toHaveBeenLastCalledWith(expect.anything(), { kind: "quit", requester: null });
    expect(mocks.countRunningSessions).toHaveBeenLastCalledWith(null);

    // The teardown itself does not change: the relaunch is Rust's.
    gate.mock.lastCall![0].confirm();
    await settle();
    quitTeardown();
    await settle();
    expect(mocks.invoke).toHaveBeenCalledWith("quit_proceed");
  });

  it("does not re-invoke the gate while a confirmation is pending", async () => {
    mocks.countRunningSessions.mockReturnValue(1);
    const adapter = fakeAdapter();
    const gate = vi.fn(); // never decides — the dialog stays up
    setQuitConfirmGate(gate);

    await triggerQuit(adapter);
    quitRequested(); // repeat trigger while confirming
    await settle();

    expect(gate).toHaveBeenCalledTimes(1);
    expect(adapter.requestSessionFlush).not.toHaveBeenCalled();
  });

  it("cancels via the gate without tearing down", async () => {
    mocks.countRunningSessions.mockReturnValue(1);
    const adapter = fakeAdapter();
    setQuitConfirmGate((ctx) => ctx.cancel());

    await triggerQuit(adapter);

    expect(mocks.invoke).toHaveBeenCalledWith("quit_cancel");
    expect(adapter.requestSessionFlush).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalledWith("quit_proceed");
  });

  // --- Vote then walk (docs/specs/standalone.md §Quit flow) -------------------

  it("votes and then waits: nothing is torn down until the walk reaches this window", async () => {
    const adapter = fakeAdapter();
    initQuitFlow(adapter);
    quitRequested();
    await settle();

    expect(mocks.invoke).toHaveBeenCalledWith("quit_vote");
    // A vote is not a teardown: another window may still decline, and nothing
    // anywhere may be destroyed until every window has agreed.
    expect(adapter.requestSessionFlush).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalledWith("quit_progress");
    expect(mocks.invoke).not.toHaveBeenCalledWith("quit_proceed");
  });

  it("a window that is not last hands the walk on instead of exiting", async () => {
    mocks.hasPendingUpdate.mockReturnValue(true);
    const adapter = fakeAdapter();
    await triggerQuit(adapter, { last: false });

    expect(adapter.drainSessionSaves).toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith("quit_window_done");
    expect(mocks.invoke).not.toHaveBeenCalledWith("quit_proceed");
    // Only `main` holds `updater:*`, and it is the window the walk tears down
    // last (docs/specs/auto-update.md).
    expect(mocks.installPendingUpdate).not.toHaveBeenCalled();
  });

  it("another window's cancel drops this window's dialog without cancelling again", async () => {
    mocks.countRunningSessions.mockReturnValue(1);
    setQuitConfirmGate(openQuitConfirm);
    await triggerQuit(fakeAdapter());
    expect(getQuitConfirmPhase()).toBe("open");

    quitCancelled();

    expect(getQuitConfirmPhase()).toBeNull();
    // The cancel already happened elsewhere; calling back would bounce it
    // around the windows.
    expect(mocks.invoke).not.toHaveBeenCalledWith("quit_cancel");
  });

  it("falls through to teardown when no gate is installed even with running sessions", async () => {
    mocks.countRunningSessions.mockReturnValue(2);
    const adapter = fakeAdapter();
    await triggerQuit(adapter);

    // No confirmation gate installed yet: unconfirmed teardown.
    expect(adapter.requestSessionFlush).toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith("quit_proceed");
  });
});
