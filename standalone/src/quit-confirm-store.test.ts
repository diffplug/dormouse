import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelQuit,
  confirmQuit,
  getQuitConfirmPhase,
  openQuitConfirm,
  subscribeQuitConfirm,
  _resetQuitConfirmForTesting,
} from "./quit-confirm-store";

// The store's only runtime dependency on ./quit is the QuitConfirmContext TYPE
// (erased), so these tests need no Tauri/orchestrator mocks: drive the gate
// with a hand-made context. The gate↔orchestrator seam itself is covered by
// quit.test.ts.
const makeCtx = () => ({ confirm: vi.fn(), cancel: vi.fn() });

describe("quit-confirm store", () => {
  beforeEach(() => {
    _resetQuitConfirmForTesting();
  });

  it("opens with phase 'open' and notifies subscribers", () => {
    const listener = vi.fn();
    subscribeQuitConfirm(listener);

    openQuitConfirm(makeCtx());

    expect(getQuitConfirmPhase()).toBe("open");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("cancel closes the dialog and calls ctx.cancel exactly once", () => {
    const ctx = makeCtx();
    openQuitConfirm(ctx);

    cancelQuit();
    expect(getQuitConfirmPhase()).toBeNull();
    expect(ctx.cancel).toHaveBeenCalledTimes(1);
    expect(ctx.confirm).not.toHaveBeenCalled();

    // A repeat cancel is a no-op.
    cancelQuit();
    expect(ctx.cancel).toHaveBeenCalledTimes(1);
  });

  it("confirm keeps the dialog up as 'quitting' and calls ctx.confirm exactly once", () => {
    const ctx = makeCtx();
    openQuitConfirm(ctx);

    confirmQuit();
    expect(getQuitConfirmPhase()).toBe("quitting");
    expect(ctx.confirm).toHaveBeenCalledTimes(1);

    // Double-confirm and late cancel are no-ops after the decision.
    confirmQuit();
    cancelQuit();
    expect(ctx.confirm).toHaveBeenCalledTimes(1);
    expect(ctx.cancel).not.toHaveBeenCalled();
    expect(getQuitConfirmPhase()).toBe("quitting");
  });

  it("ignores a redundant open while a dialog is already up", () => {
    const first = makeCtx();
    const second = makeCtx();
    openQuitConfirm(first);
    openQuitConfirm(second);

    confirmQuit();
    // The decision reaches the first request's context, not the ignored one.
    expect(first.confirm).toHaveBeenCalledTimes(1);
    expect(second.confirm).not.toHaveBeenCalled();
  });
});
