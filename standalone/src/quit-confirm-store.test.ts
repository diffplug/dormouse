import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TauriAdapter } from "./tauri-adapter";

// The store wires into the same quit orchestrator quit.test.ts exercises, so it
// needs the same Tauri surface mocked (core invoke + event listen) plus the two
// orchestrator collaborators. `countRunningSessions` is the trigger-time count;
// the dialog's *live* count (subscribeToTerminalPaneState) is component-only and
// not under test here.
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

import { initQuitFlow, _resetForTesting } from "./quit";
import {
  cancelQuit,
  confirmQuit,
  getQuitConfirmSnapshot,
  installQuitConfirmGate,
  subscribeQuitConfirm,
  _resetQuitConfirmForTesting,
} from "./quit-confirm-store";

// The captured `dormouse://quit-requested` listener; call it to simulate Rust
// emitting a quit request.
let quitRequested: (() => void) | null = null;

const settle = () => new Promise((r) => setTimeout(r, 0));

// A fake adapter whose teardown steps append their name to `order` so the call
// sequence is observable (mirrors quit.test.ts).
function fakeAdapter(order: string[] = []): TauriAdapter {
  const step = (name: string) => vi.fn(async () => { order.push(name); });
  return {
    requestSessionFlush: step("flush"),
    gracefulKillAllPtys: step("gracefulKill"),
    drainSessionSaves: step("drain"),
  } as unknown as TauriAdapter;
}

// Wire the orchestrator + the confirm gate, then fire Rust's quit-requested.
function triggerQuit(adapter: TauriAdapter): void {
  initQuitFlow(adapter);
  installQuitConfirmGate();
  quitRequested!();
}

describe("quit-confirm store", () => {
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
  });

  afterEach(() => _resetQuitConfirmForTesting());

  it("with no running sessions, quits without opening the dialog", async () => {
    const adapter = fakeAdapter();
    triggerQuit(adapter);
    await settle();

    // Idle shells: the gate is never consulted; unconfirmed teardown proceeds.
    expect(getQuitConfirmSnapshot()).toBeNull();
    expect(adapter.requestSessionFlush).toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith("quit_proceed");
  });

  it("opens the dialog with the running count when work is live", () => {
    mocks.countRunningSessions.mockReturnValue(3);
    triggerQuit(fakeAdapter());

    expect(getQuitConfirmSnapshot()).toEqual({ runningCountAtRequest: 3 });
  });

  it("cancel closes the dialog and invokes quit_cancel without tearing down", async () => {
    mocks.countRunningSessions.mockReturnValue(2);
    const adapter = fakeAdapter();
    triggerQuit(adapter);
    expect(getQuitConfirmSnapshot()).not.toBeNull();

    cancelQuit();
    await settle();

    expect(getQuitConfirmSnapshot()).toBeNull();
    expect(mocks.invoke).toHaveBeenCalledWith("quit_cancel");
    // App + terminals untouched.
    expect(adapter.requestSessionFlush).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalledWith("quit_proceed");
  });

  it("confirm runs the teardown and proceeds to exit", async () => {
    mocks.countRunningSessions.mockReturnValue(1);
    const order: string[] = [];
    const adapter = fakeAdapter(order);
    triggerQuit(adapter);

    confirmQuit();
    await settle();

    expect(order).toEqual(["flush", "gracefulKill", "flush", "drain"]);
    expect(mocks.invoke).toHaveBeenCalledWith("quit_proceed");
  });

  it("a second confirm after teardown started is a no-op", async () => {
    mocks.countRunningSessions.mockReturnValue(1);
    const order: string[] = [];
    const adapter = fakeAdapter(order);
    triggerQuit(adapter);

    confirmQuit();
    confirmQuit(); // double-click guard: activeCtx already resolved
    await settle();

    // Teardown ran exactly once.
    expect(adapter.requestSessionFlush).toHaveBeenCalledTimes(2); // steps 1 & 3 of one run
    const proceeds = mocks.invoke.mock.calls.filter((c) => c[0] === "quit_proceed").length;
    expect(proceeds).toBe(1);
  });

  it("a second quit-request while the dialog is open does not re-open or stack", () => {
    mocks.countRunningSessions.mockReturnValue(2);
    let emits = 0;
    subscribeQuitConfirm(() => { emits += 1; });
    triggerQuit(fakeAdapter());
    expect(getQuitConfirmSnapshot()).toEqual({ runningCountAtRequest: 2 });
    const openEmits = emits;

    // Count changes and a repeat trigger fires; the orchestrator dedupes on
    // quitPhase, so the gate is not re-invoked and the snapshot is unchanged.
    mocks.countRunningSessions.mockReturnValue(5);
    quitRequested!();

    expect(getQuitConfirmSnapshot()).toEqual({ runningCountAtRequest: 2 });
    expect(emits).toBe(openEmits); // no additional store emission
  });
});
