import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { countRunningSessions } from "dormouse-lib/lib/terminal-registry";
import { notepadSurfaceIds, removeSurface } from "dormouse-lib/lib/notepad/notepad-store";
import { openQuitArchiveFailure, openQuitConfirm, type QuitConfirmIntent } from "./quit-confirm-store";
import { archiveNotesBeforeTeardown } from "./teardown-archive";
import type { TauriAdapter } from "./tauri-adapter";

/**
 * Closing one window of several (`docs/specs/standalone.md` → "Per-window
 * close"). Rust prevents the close and emits
 * `dormouse://window-close-requested`; this acks, asks, archives, kills, and
 * calls back `window_close_proceed`. The last window's close is a quit instead,
 * and never reaches here.
 *
 * A close is **deliberate**: unlike a quit it archives the notes AND takes the
 * window's snapshot off disk, so the next launch does not reopen it. It runs no
 * agent-recovery capture for the same reason — nothing is coming back.
 */

const GRACEFUL_KILL_MS = 2000;
/** The whole teardown, past the human decision. Well under Rust's own budget. */
const CLOSE_TEARDOWN_CEILING_MS = 8000;

type ClosePhase = "idle" | "confirming" | "archive-failed" | "closing";

let phase: ClosePhase = "idle";
let closeAdapter: TauriAdapter | null = null;
/** Names this window in the dialog while more than one is open. */
let describeWindow: () => string | undefined = () => undefined;

const CLOSE_INTENT = (): QuitConfirmIntent => ({
  kind: "close-window",
  windowName: describeWindow(),
});

export function initWindowClose(
  adapter: TauriAdapter,
  options: { windowName?: () => string | undefined } = {},
): void {
  closeAdapter = adapter;
  if (options.windowName) describeWindow = options.windowName;
  void listen("dormouse://window-close-requested", handleCloseRequested);
}

function handleCloseRequested(): void {
  // Ack first — stands Rust's ack watchdog down even when the trigger is
  // deduped below, exactly as the quit orchestrator does.
  void invoke("window_close_ack").catch(() => {});
  if (phase !== "idle") return;

  // The registry is per webview, so this is already this window's running work.
  if (countRunningSessions() > 0) {
    phase = "confirming";
    openQuitConfirm({ confirm: () => void archiveThenClose(), cancel: cancelClose }, CLOSE_INTENT());
    return;
  }
  void archiveThenClose();
}

async function archiveThenClose(): Promise<void> {
  // Committed from here: the gate is an await, so without this a second trigger
  // arriving mid-archive would start a parallel close.
  phase = "closing";
  try {
    await archiveNotesBeforeTeardown();
  } catch (err) {
    // The close stays pending in Rust — its wait past the ack is unbounded
    // precisely because it waits on a human.
    phase = "archive-failed";
    openQuitArchiveFailure(
      err instanceof Error ? err.message : String(err),
      {
        confirm: () => {
          // Close anyway: the user accepts losing these notes, so forget them
          // and take the teardown that has nothing left to archive.
          for (const id of notepadSurfaceIds()) removeSurface(id);
          void runCloseTeardown();
        },
        cancel: cancelClose,
      },
      CLOSE_INTENT(),
    );
    return;
  }
  await runCloseTeardown();
}

async function runCloseTeardown(): Promise<void> {
  phase = "closing";
  const adapter = closeAdapter;
  try {
    // Remove the snapshot BEFORE the kill, so an exit-triggered save cannot
    // write it back: Rust refuses every later save for this label.
    await invoke("remove_window_session").catch((err) =>
      console.warn("[window-close] remove_window_session failed; proceeding", err));
    // No `ids`: Rust scopes the kill to this window's own PTYs, and a sibling's
    // terminals must never be reachable from here.
    if (adapter) {
      await Promise.race([
        adapter.gracefulKillPtys(GRACEFUL_KILL_MS),
        new Promise((resolve) => setTimeout(resolve, CLOSE_TEARDOWN_CEILING_MS)),
      ]);
    }
  } catch (err) {
    // A failing step must not leave the window un-closeable.
    console.warn("[window-close] teardown step failed; closing anyway", err);
  } finally {
    void invoke("window_close_proceed").catch(() => {});
  }
}

function cancelClose(): void {
  phase = "idle";
  void invoke("window_close_cancel").catch(() => {});
}

/** @internal Reset module state for testing. */
export function _resetWindowCloseForTesting(): void {
  phase = "idle";
  closeAdapter = null;
  describeWindow = () => undefined;
}
