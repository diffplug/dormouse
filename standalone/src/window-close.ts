import { invoke } from "@tauri-apps/api/core";
import { windowNeedsCloseConfirmation, windowReopenSnapshot } from "dormouse-lib/components/wall/window-reopen";
import { openQuitConfirm } from "./quit-confirm-store";
import { createTeardownFlow } from "./teardown-flow";
import type { TauriAdapter } from "./tauri-adapter";
import { hasPendingUpdate } from "./updater";
import { withTimeout } from "./with-timeout";
import { listenToWindow } from "./window-label";

/**
 * Closing one window of several (`docs/specs/standalone.md` → "Per-window
 * close"). Rust prevents the close and emits
 * `dormouse://window-close-requested`; this acks, asks, kills, and calls back
 * `close_window`. The last window's close is a quit instead, and never reaches
 * here.
 *
 * A close is **deliberate**: unlike a quit it takes the window's snapshot off
 * disk, so the next launch does not reopen it. It runs no agent-recovery
 * capture for the same reason — nothing resumes; Reopen rebuilds a window
 * whose close asked nothing from the record it leaves the host.
 *
 * The ack / confirm half is `createTeardownFlow`, shared with the quit; what is
 * close-specific is the teardown below.
 */

const GRACEFUL_KILL_MS = 2000;
/** The whole teardown, past the human decision. Well under Rust's own budget. */
const CLOSE_TEARDOWN_CEILING_MS = 8000;

let closeAdapter: TauriAdapter | null = null;

const flow = createTeardownFlow({
  kind: "close-window",
  ack: "window_close_ack",
  cancelCommand: "window_close_cancel",
  // Always asked, never optional: a close is one window's own decision, and the
  // dialog host is mounted in every window.
  gate: () => openQuitConfirm,
  // Asks when any member's own close would (docs/specs/reopen.md). An approved
  // download lives in this webview's memory, so closing throws it away — worth
  // asking about even when everything else could be reopened.
  mustConfirm: () => windowNeedsCloseConfirmation() || hasPendingUpdate(),
  proceed: runCloseTeardown,
});

export function initWindowClose(adapter: TauriAdapter): void {
  closeAdapter = adapter;
  void listenToWindow("dormouse://window-close-requested", () => {
    flow.request({
      kind: "close-window",
      ...(hasPendingUpdate() ? { discardsUpdate: true } : {}),
    });
  });
}

async function runCloseTeardown(): Promise<void> {
  const adapter = closeAdapter;
  // First, while every Session is still here to read: the closing webview
  // dies, so the host keeps the record (docs/specs/reopen.md).
  await pushReopenRecord().catch((err) => console.warn("[window-close] no reopen record; proceeding", err));
  try {
    // Remove the snapshot BEFORE the kill, so an exit-triggered save cannot
    // write it back: Rust refuses every later save for this label.
    await invoke("remove_window_session").catch((err) =>
      console.warn("[window-close] remove_window_session failed; proceeding", err));
    // No `ids`: Rust scopes the kill to this window's own PTYs, and a sibling's
    // terminals must never be reachable from here.
    if (adapter) {
      await withTimeout(
        adapter.gracefulKillPtys(GRACEFUL_KILL_MS),
        CLOSE_TEARDOWN_CEILING_MS,
        `[window-close] kill exceeded ${CLOSE_TEARDOWN_CEILING_MS}ms; closing anyway`,
      );
    }
  } catch (err) {
    // A failing step must not leave the window un-closeable.
    console.warn("[window-close] teardown step failed; closing anyway", err);
  } finally {
    void invoke("close_window").catch(() => {});
  }
}

async function pushReopenRecord(): Promise<void> {
  const snapshot = windowReopenSnapshot();
  if (snapshot) await invoke("push_closed_window", { snapshot: JSON.stringify(snapshot), closedAt: Date.now() });
}

/** @internal Reset module state for testing. */
export function _resetWindowCloseForTesting(): void {
  flow.reset();
  closeAdapter = null;
}
