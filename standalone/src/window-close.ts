import { invoke } from "@tauri-apps/api/core";
import { flushWindowSession } from "dormouse-lib/lib/window-session-aggregator";
import { countRunningSessions } from "dormouse-lib/lib/terminal-registry";
import { dismissQuitConfirm, openQuitConfirm, showCloseFailure, showCloseCommitUncertain } from "./quit-confirm-store";
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
 * capture for the same reason — nothing is coming back.
 *
 * The ack / confirm half is `createTeardownFlow`, shared with the quit; what is
 * close-specific is the teardown below.
 */

const GRACEFUL_KILL_MS = 2000;
/** PTY teardown after durable removal; native preparation has its own bound. */
const CLOSE_TEARDOWN_CEILING_MS = 8000;
const RETAINED_WINDOW_DRAIN_MS = 2000;
const RETAINED_WINDOW_WRITE_MS = 1000;

let closeAdapter: TauriAdapter | null = null;

const flow = createTeardownFlow({
  kind: "close-window",
  ack: "window_close_ack",
  cancelCommand: "window_close_cancel",
  // Always asked, never optional: a close is one window's own decision, and the
  // dialog host is mounted in every window.
  gate: () => openQuitConfirm,
  // An approved download lives in this webview's memory, so closing throws it
  // away — worth asking about even with nothing running.
  mustConfirm: () => countRunningSessions() > 0 || hasPendingUpdate(),
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
  void listenToWindow<string>("dormouse://window-close-failed", (event) => {
    void retainWindowAfterFailure(event.payload);
  });
}

async function retainWindowAfterFailure(error: unknown): Promise<void> {
  const reason = String(error);
  if (reason.includes('close-commit-uncertain:')) {
    // The native commit still owns its files: never release the arbiter or
    // enable a resave/second close while a late unlink may finish.
    showCloseCommitUncertain(`Closing could not finish safely: ${reason}`);
    return;
  }
  // Retire the previous native handshake before offering a retry. A late
  // cancel must never clear the retry's fresh token while its dialog is open.
  try {
    await invoke('window_close_cancel');
  } catch (cancelError) {
    showCloseCommitUncertain('The Window is retained, but its save refusal could not be released: ' + String(cancelError));
    return;
  }
  // A refused in-flight write must settle before publishing the same value:
  // the synchronous cache coalesces identical values while its save is pending.
  // Wall dirty tracking already ended when it published into the aggregate;
  // a heartbeat may never republish this retained Window without this retry.
  try {
    if (closeAdapter) await closeAdapter.drainSessionSaves(RETAINED_WINDOW_DRAIN_MS);
    await withTimeout(
      flushWindowSession(),
      RETAINED_WINDOW_WRITE_MS,
      '[window-close] retained Window write timed out; Window stays open',
    );
    closeAdapter?.retrySessionSave();
    if (closeAdapter) await closeAdapter.drainSessionSaves(RETAINED_WINDOW_DRAIN_MS);
  } catch (saveError) {
    console.warn('[window-close] retained Window resave failed:', saveError);
  }
  flow.reset();
  showCloseFailure({
    reason: `Workspaces were retained. ${reason}`,
    retry: () => {
      dismissQuitConfirm('close-window');
      void invoke('retry_window_close').catch(retainWindowAfterFailure);
    },
    stay: () => dismissQuitConfirm('close-window'),
  });
}

async function runCloseTeardown(): Promise<void> {
  const adapter = closeAdapter;
  try {
    // Cancellation can win only before native disk mutation. A failure retains
    // this window and its live PTYs; the old best-effort path lost recovery.
    await invoke("remove_window_session");
  } catch (error) {
    await retainWindowAfterFailure(error);
    return;
  }
  try {
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
