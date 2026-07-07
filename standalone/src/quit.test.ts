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
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("dormouse-lib/lib/terminal-registry", () => ({
  countRunningSessions: mocks.countRunningSessions,
}));
vi.mock("./updater", () => ({
  hasPendingUpdate: mocks.hasPendingUpdate,
  installPendingUpdate: mocks.installPendingUpdate,
}));

import { initQuitFlow, setQuitConfirmGate, _resetForTesting } from "./quit";

// The captured `dormouse://quit-requested` listener; call it to simulate Rust
// emitting a quit request.
let quitRequested: (() => void) | null = null;

// Drain the microtask-driven teardown chain (no real timers on the happy path —
// withTimeout's 8s guard is cleared when the work wins).
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
    quitRequested = null;
    mocks.listen.mockImplementation((event: string, cb: () => void) => {
      if (event === "dormouse://quit-requested") quitRequested = cb;
      return Promise.resolve(() => {});
    });
    mocks.countRunningSessions.mockReturnValue(0);
    mocks.hasPendingUpdate.mockReturnValue(false);
    mocks.installPendingUpdate.mockResolvedValue(undefined);
    mocks.invoke.mockResolvedValue(undefined);
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

  it("runs teardown steps flush → kill → flush → drain → install → proceed in order", async () => {
    const order: string[] = [];
    mocks.invoke.mockImplementation(async (cmd: string) => {
      order.push(cmd);
      return undefined;
    });
    mocks.hasPendingUpdate.mockReturnValue(true);
    mocks.installPendingUpdate.mockImplementation(async () => {
      order.push("install");
    });

    await triggerQuit(fakeAdapter(order));

    expect(order).toEqual([
      "quit_ack",
      "flush",
      "gracefulKill",
      "flush",
      "drain",
      "install",
      "quit_proceed",
    ]);
  });

  it("skips install when no update is pending", async () => {
    mocks.hasPendingUpdate.mockReturnValue(false);
    await triggerQuit(fakeAdapter());

    expect(mocks.installPendingUpdate).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith("quit_proceed");
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

  it("falls through to teardown when no gate is installed even with running sessions", async () => {
    mocks.countRunningSessions.mockReturnValue(2);
    const adapter = fakeAdapter();
    await triggerQuit(adapter);

    // No confirmation gate installed yet: unconfirmed teardown.
    expect(adapter.requestSessionFlush).toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith("quit_proceed");
  });
});
