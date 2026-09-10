import { invoke } from "@tauri-apps/api/core";
import { openQuitConfirm } from "./quit-confirm-store";
import { createTeardownFlow, describeWindow } from "./teardown-flow";
import type { TauriAdapter } from "./tauri-adapter";
import { withTimeout } from "./with-timeout";
import { listenToWindow } from "./window-label";

/**
 * Closing one window of several (`docs/specs/standalone.md` → "Per-window
 * close"). Rust prevents the close and emits
 * `dormouse://window-close-requested`; this acks, asks, archives, kills, and
 * calls back `close_window`. The last window's close is a quit instead, and
 * never reaches here.
 *
 * A close is **deliberate**: unlike a quit it archives the notes AND takes the
 * window's snapshot off disk, so the next launch does not reopen it. It runs no
 * agent-recovery capture for the same reason — nothing is coming back.
 *
 * The ack / confirm / archive half is `createTeardownFlow`, shared with the
 * quit; what is close-specific is the teardown below.
 */

const GRACEFUL_KILL_MS = 2000;
/** The whole teardown, past the human decision. Well under Rust's own budget. */
const CLOSE_TEARDOWN_CEILING_MS = 8000;

let closeAdapter: TauriAdapter | null = null;

const flow = createTeardownFlow({
  ack: "window_close_ack",
  cancelCommand: "window_close_cancel",
  // Always asked, never optional: a close is one window's own decision, and the
  // dialog host is mounted in every window.
  gate: () => openQuitConfirm,
  proceed: runCloseTeardown,
});

export function initWindowClose(adapter: TauriAdapter): void {
  closeAdapter = adapter;
  void listenToWindow("dormouse://window-close-requested", () => {
    flow.request({ kind: "close-window", windowName: describeWindow() });
  });
}

async function runCloseTeardown(): Promise<void> {
  const adapter = closeAdapter;
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

/** @internal Reset module state for testing. */
export function _resetWindowCloseForTesting(): void {
  flow.reset();
  closeAdapter = null;
}
