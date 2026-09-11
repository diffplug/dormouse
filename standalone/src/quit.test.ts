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
  archiveSurfaceNotes: vi.fn(async (_ids: readonly string[], _opts?: { signal?: AbortSignal }) => {}),
  notepadSurfaceIds: vi.fn(() => [] as string[]),
  removeSurface: vi.fn(),
  flushWindowSession: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("dormouse-lib/lib/terminal-registry", () => ({
  countRunningSessions: mocks.countRunningSessions,
}));
// The archive gate's two collaborators. Mocked for the same reason as the
// registry: the real modules pull the whole lib platform in behind them, and
// what this file tests is the ordering around them.
vi.mock("dormouse-lib/lib/notepad/close-coordinator", () => ({
  archiveSurfaceNotes: mocks.archiveSurfaceNotes,
}));
vi.mock("dormouse-lib/lib/notepad/notepad-store", () => ({
  notepadSurfaceIds: mocks.notepadSurfaceIds,
  removeSurface: mocks.removeSurface,
}));
// The aggregator's write step. Mocked for the same reason as the registry: what
// this file tests is where it sits in the order.
vi.mock("dormouse-lib/lib/window-session-aggregator", () => ({
  flushWindowSession: mocks.flushWindowSession,
}));
vi.mock("./updater", () => ({
  hasPendingUpdate: mocks.hasPendingUpdate,
  installPendingUpdate: mocks.installPendingUpdate,
}));

import { initQuitFlow, setQuitConfirmGate, _resetForTesting } from "./quit";
// The quit-confirm store is the real one: the archive-failed phase is the
// observable half of the gate's failure path.
import {
  cancelQuit as dismissQuitDialog,
  confirmQuit,
  getQuitArchiveError,
  getQuitConfirmPhase,
  _resetQuitConfirmForTesting,
} from "./quit-confirm-store";

/** One Surface holding notes, as `notepadSurfaceIds` reports it. */
const oneNotedSurface = () => ["pane-a"];

// The captured `dormouse://quit-requested` listener; call it to simulate Rust
// emitting a quit request.
let quitRequested: (() => void) | null = null;

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
    gracefulKillAllPtys: step("gracefulKill"),
    drainSessionSaves: step("drain"),
  } as unknown as TauriAdapter;
}

// Wire the orchestrator, fire Rust's quit-requested event, drain the chain.
async function triggerQuit(adapter: TauriAdapter): Promise<void> {
  initQuitFlow(adapter);
  quitRequested!();
  await settle();
}

describe("quit orchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    _resetQuitConfirmForTesting();
    quitRequested = null;
    mocks.listen.mockImplementation((event: string, cb: () => void) => {
      if (event === "dormouse://quit-requested") quitRequested = cb;
      return Promise.resolve(() => {});
    });
    mocks.countRunningSessions.mockReturnValue(0);
    mocks.hasPendingUpdate.mockReturnValue(false);
    mocks.installPendingUpdate.mockResolvedValue(undefined);
    mocks.invoke.mockResolvedValue(undefined);
    mocks.archiveSurfaceNotes.mockResolvedValue(undefined);
    mocks.notepadSurfaceIds.mockReturnValue([]);
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
      mocks.flushWindowSession.mockImplementation(slow("flushWindow", 1000));

      initQuitFlow(adapter);
      quitRequested!();
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
      quitRequested!();
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

    quitRequested!(); // starts teardown; parked at the first flush
    await settle();
    quitRequested!(); // repeat trigger — must not restart teardown
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

  it("does not re-invoke the gate while a confirmation is pending", async () => {
    mocks.countRunningSessions.mockReturnValue(1);
    const adapter = fakeAdapter();
    const gate = vi.fn(); // never decides — the dialog stays up
    setQuitConfirmGate(gate);

    await triggerQuit(adapter);
    quitRequested!(); // repeat trigger while confirming
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

  // --- The notepad archive gate (docs/specs/notepad.md → "Standalone quit") ---

  it("archives every Surface holding notes before the first quit_progress", async () => {
    mocks.notepadSurfaceIds.mockReturnValue(oneNotedSurface());
    const order: string[] = [];
    mocks.invoke.mockImplementation(async (cmd: string) => {
      order.push(cmd);
      return undefined;
    });
    mocks.archiveSurfaceNotes.mockImplementation(async () => {
      order.push("archive");
    });

    await triggerQuit(fakeAdapter(order));

    // The gate is a step before teardown, not inside it: nothing has told Rust
    // teardown began when the archive runs.
    expect(order.slice(0, 3)).toEqual(["quit_ack", "archive", "quit_progress"]);
    expect(mocks.archiveSurfaceNotes).toHaveBeenCalledWith(["pane-a"], expect.anything());
    expect(mocks.invoke).toHaveBeenCalledWith("quit_proceed");
  });

  it("skips the archive entirely when no Surface holds notes", async () => {
    await triggerQuit(fakeAdapter());

    expect(mocks.archiveSurfaceNotes).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith("quit_proceed");
  });

  it("runs the gate after the running-work confirmation, not before it", async () => {
    mocks.countRunningSessions.mockReturnValue(2);
    mocks.notepadSurfaceIds.mockReturnValue(oneNotedSurface());
    const gate = vi.fn(); // never decides
    setQuitConfirmGate(gate);

    await triggerQuit(fakeAdapter());

    expect(gate).toHaveBeenCalledTimes(1);
    expect(mocks.archiveSurfaceNotes).not.toHaveBeenCalled();
  });

  it("leaves the quit pending in Rust and opens the archive-failed dialog when the write fails", async () => {
    // `quit_cancel` retires Rust's watchdog. Calling it here would leave a later
    // "Quit anyway" tearing down unwatched, so the pending quit stays in its
    // unbounded phase-2 wait — which is what waits on a human.
    mocks.notepadSurfaceIds.mockReturnValue(oneNotedSurface());
    mocks.archiveSurfaceNotes.mockRejectedValue(new Error("disk is full"));
    const adapter = fakeAdapter();

    await triggerQuit(adapter);

    expect(mocks.invoke).not.toHaveBeenCalledWith("quit_cancel");
    expect(mocks.invoke).not.toHaveBeenCalledWith("quit_progress");
    expect(mocks.invoke).not.toHaveBeenCalledWith("quit_proceed");
    expect(adapter.requestSessionFlush).not.toHaveBeenCalled();
    expect(getQuitConfirmPhase()).toBe("archive-failed");
    expect(getQuitArchiveError()).toBe("disk is full");
  });

  it("deduplicates a repeat quit trigger while the archive-failed dialog is up", async () => {
    mocks.notepadSurfaceIds.mockReturnValue(oneNotedSurface());
    mocks.archiveSurfaceNotes.mockRejectedValue(new Error("disk is full"));
    await triggerQuit(fakeAdapter());
    mocks.archiveSurfaceNotes.mockClear();

    quitRequested!();
    await settle();

    // Acked (Rust's watchdog stands down) but the flow does not restart.
    expect(mocks.archiveSurfaceNotes).not.toHaveBeenCalled();
    expect(getQuitConfirmPhase()).toBe("archive-failed");
  });

  it("Quit anyway discards the notes and runs the teardown", async () => {
    mocks.notepadSurfaceIds.mockReturnValue(oneNotedSurface());
    mocks.archiveSurfaceNotes.mockRejectedValue(new Error("disk is full"));
    const adapter = fakeAdapter();
    await triggerQuit(adapter);

    confirmQuit();
    await settle();

    expect(mocks.removeSurface).toHaveBeenCalledWith("pane-a");
    expect(adapter.requestSessionFlush).toHaveBeenCalled();
    // Never cancelled, so the teardown runs under the watchdog that was already
    // armed for this quit.
    expect(mocks.invoke).not.toHaveBeenCalledWith("quit_cancel");
    expect(mocks.invoke).toHaveBeenCalledWith("quit_proceed");
  });

  it("Cancel leaves the app running and lets a later quit start fresh", async () => {
    mocks.notepadSurfaceIds.mockReturnValue(oneNotedSurface());
    mocks.archiveSurfaceNotes.mockRejectedValue(new Error("disk is full"));
    const adapter = fakeAdapter();
    await triggerQuit(adapter);

    dismissQuitDialog();
    // Cancel is the one branch that drops the pending quit in Rust.
    expect(mocks.invoke).toHaveBeenCalledWith("quit_cancel");
    expect(getQuitConfirmPhase()).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalledWith("quit_proceed");

    // The flow returned to idle, so the next trigger runs the gate again.
    mocks.archiveSurfaceNotes.mockResolvedValue(undefined);
    quitRequested!();
    await settle();
    expect(adapter.requestSessionFlush).toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith("quit_proceed");
  });

  it("treats an archive that outruns its 3s bound as a failure", async () => {
    vi.useFakeTimers();
    try {
      mocks.notepadSurfaceIds.mockReturnValue(oneNotedSurface());
      mocks.archiveSurfaceNotes.mockReturnValue(new Promise<void>(() => {})); // never settles
      const adapter = fakeAdapter();
      initQuitFlow(adapter);
      quitRequested!();

      await vi.advanceTimersByTimeAsync(3000);

      expect(getQuitConfirmPhase()).toBe("archive-failed");
      expect(getQuitArchiveError()).toContain("3s");
      expect(adapter.requestSessionFlush).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts the archive it stopped waiting for, so a late success cannot empty the notepads", async () => {
    // `withDeadline` only stops the waiting. Without the signal the archive
    // keeps running, succeeds minutes later, and calls `removeSurface` on every
    // Surface — in front of a user who chose Cancel.
    vi.useFakeTimers();
    try {
      mocks.notepadSurfaceIds.mockReturnValue(oneNotedSurface());
      let signal: AbortSignal | undefined;
      mocks.archiveSurfaceNotes.mockImplementation((_ids, opts) => {
        signal = opts?.signal;
        return new Promise<void>(() => {}); // never settles
      });
      initQuitFlow(fakeAdapter());
      quitRequested!();
      await Promise.resolve();
      expect(signal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(3000);

      expect(signal?.aborted).toBe(true);
      expect(getQuitConfirmPhase()).toBe("archive-failed");
    } finally {
      vi.useRealTimers();
    }
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
