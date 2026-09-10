import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { countRunningSessions } from "dormouse-lib/lib/terminal-registry";
import { archiveSurfaceNotes } from "dormouse-lib/lib/notepad/close-coordinator";
import { notepadSurfaceIds, removeSurface } from "dormouse-lib/lib/notepad/notepad-store";
import { flushWindowSession } from "dormouse-lib/lib/window-session-aggregator";
import { DEFAULT_RECOVERY_WAIT_MS } from "dormouse-lib/host/recovery-capture";
import type { TauriAdapter } from "./tauri-adapter";
import { openQuitArchiveFailure } from "./quit-confirm-store";
import { hasPendingUpdate, installPendingUpdate } from "./updater";
import { withDeadline, withTimeout } from "./with-timeout";

/**
 * Quit orchestrator. Rust intercepts every quit trigger and emits
 * `dormouse://quit-requested`; this module acks, runs the graceful teardown,
 * and calls `quit_proceed` on every path so the app always exits. Protocol,
 * teardown ordering, and rationale: docs/specs/standalone.md §Quit flow.
 */

// One quit flow at a time: repeated quit-requested events are ignored while a
// confirmation decision is outstanding, the archive gate is asking about notes
// it could not store, or a teardown is running.
let quitPhase: "idle" | "confirming" | "archive-failed" | "tearing-down" = "idle";
// The adapter to tear down, captured at init.
let quitAdapter: TauriAdapter | null = null;

// The quit-confirmation gate (docs/specs/standalone.md §Quit flow,
// "Confirmation dialog"). When quit fires with ≥1 running session and a gate is
// installed, the gate owns the decision and must eventually call
// `ctx.confirm()` (run the teardown) or `ctx.cancel()` (abort). With no gate
// installed the handler falls through to an immediate unconfirmed teardown.
export interface QuitConfirmContext {
  confirm: () => void;
  cancel: () => void;
}
type QuitConfirmGate = (ctx: QuitConfirmContext) => void;
let quitConfirmGate: QuitConfirmGate | null = null;

/** Register (or clear with null) the running-work confirmation gate. */
export function setQuitConfirmGate(gate: QuitConfirmGate | null): void {
  quitConfirmGate = gate;
}

export function initQuitFlow(adapter: TauriAdapter): void {
  quitAdapter = adapter;
  void listen("dormouse://quit-requested", handleQuitRequested);
}

function handleQuitRequested(): void {
  // Ack first — stands Rust's phase-1 watchdog down even when the trigger is
  // deduped below (a repeated trigger re-emits, so re-acking is expected).
  void invoke("quit_ack").catch(() => {});

  if (quitPhase !== "idle") return;

  if (countRunningSessions() > 0 && quitConfirmGate) {
    quitPhase = "confirming";
    quitConfirmGate({
      confirm: () => void archiveThenTeardown(),
      cancel: cancelQuit,
    });
    return;
  }
  void archiveThenTeardown();
}

// The archive write is a host round trip; a wedged one must not hold the quit
// open, so it gets its own bound ahead of the teardown's.
const ARCHIVE_GATE_MS = 3000;

/**
 * The notepad's quit gate (docs/specs/notepad.md → "Standalone quit"): every
 * Surface holding notes or a pending batch identity participates in one archive
 * mutation, after the running-work decision and before teardown begins.
 * Rejects with a user-presentable message when the write fails or outruns its
 * bound — the caller turns that into Cancel / Quit anyway.
 */
export async function archiveNotesBeforeQuit(): Promise<void> {
  const ids = notepadSurfaceIds();
  if (ids.length === 0) return;
  // The deadline only stops us *waiting*; the archive itself keeps running and
  // may still succeed. The signal is what stops it emptying every notepad
  // afterwards, behind a user who has been told their notes were not stored and
  // has chosen Cancel.
  const gaveUp = new AbortController();
  try {
    await withDeadline(
      archiveSurfaceNotes(ids, { signal: gaveUp.signal }),
      ARCHIVE_GATE_MS,
      `The notepad archive did not finish within ${ARCHIVE_GATE_MS / 1000}s.`,
    );
  } catch (err) {
    gaveUp.abort();
    throw err;
  }
}

// The decision is made; archive the notes, then tear down. A refused archive is
// the one thing that stops a confirmed quit, and only until the user answers.
async function archiveThenTeardown(): Promise<void> {
  // Committed from here: the gate is an await, so without this a second trigger
  // arriving mid-archive would start a parallel flow.
  quitPhase = "tearing-down";
  try {
    await archiveNotesBeforeQuit();
  } catch (err) {
    // The quit stays pending in Rust. Its phase-2 wait is unbounded precisely
    // because it waits on a human (docs/specs/standalone.md → "Quit flow"), and
    // cancelling here would retire the watchdog that a later Quit anyway still
    // needs. Hold the flow in `archive-failed` so a repeat trigger is deduped
    // exactly like a pending confirmation.
    quitPhase = "archive-failed";
    openQuitArchiveFailure(err instanceof Error ? err.message : String(err), {
      confirm: () => {
        // Quit anyway: the user accepts losing these notes, so forget them and
        // take the teardown that no longer has anything to archive — watchdog
        // still armed, because nothing cancelled the pending quit.
        for (const id of notepadSurfaceIds()) removeSurface(id);
        void runQuitTeardown();
      },
      // Cancel is the one branch that drops the pending quit in Rust.
      cancel: cancelQuit,
    });
    return;
  }
  await runQuitTeardown();
}

// Each teardown step's own bound, and the ceiling derived from them. The two
// steps that reach the sidecar wait `timeout + SIDECAR_ROUND_TRIP_MARGIN_MS` —
// the margin Rust adds in `standalone/src-tauri/src/lib.rs` — so the webview can
// observe more than the number it passed in. A ceiling below the sum would abort
// the last steps of a slow teardown instead of guarding a wedged one, and those
// last steps are the final save.
const SIDECAR_ROUND_TRIP_MARGIN_MS = 1500;
const PRE_KILL_FLUSH_MS = 1500;
const GRACEFUL_KILL_MS = 2000;
const POST_KILL_FLUSH_MS = 1500;
const DRAIN_MS = 2000;
const STEP_BUDGET_TOTAL_MS =
  (DEFAULT_RECOVERY_WAIT_MS + SIDECAR_ROUND_TRIP_MARGIN_MS) +
  PRE_KILL_FLUSH_MS +
  (GRACEFUL_KILL_MS + SIDECAR_ROUND_TRIP_MARGIN_MS) +
  POST_KILL_FLUSH_MS +
  DRAIN_MS;
/** Belt-and-suspenders over the summed step budgets, with slack for scheduling.
 *  Stays under Rust's `QUIT_PHASE_TIMEOUT_MS` (14 000 ms), which is what actually
 *  forces the exit. Exported for the test that pins it above the sum. */
export const QUIT_TEARDOWN_CEILING_MS = STEP_BUDGET_TOTAL_MS + 1000;

// Ordering and rationale: docs/specs/standalone.md §Quit flow (Teardown
// ordering). `quit_progress` tells Rust teardown has begun (ending the
// confirmation-wait suspension) and marks each phase boundary so its watchdog
// gives teardown and install separate budgets rather than one shared clock.
async function runQuitTeardown(): Promise<void> {
  quitPhase = "tearing-down";
  const adapter = quitAdapter;
  try {
    void invoke("quit_progress").catch(() => {}); // teardown phase begins
    if (adapter) {
      await withTimeout(
        (async () => {
          // Capture FIRST: an agent's resume invocation exists only between the
          // interrupt and the kill, and it is the one thing here that cannot be
          // reconstructed afterwards. Losing it must never cost the save behind
          // it, so this step alone cannot abort the rest.
          // No `ids`: a quit tears down the whole Window, so the capture takes
          // every live PTY.
          await adapter.captureAgentRecovery(DEFAULT_RECOVERY_WAIT_MS).catch((err) =>
            console.warn("[quit] agent recovery capture failed; proceeding", err));
          await adapter.requestSessionFlush(PRE_KILL_FLUSH_MS); // save while PTYs are alive
          await adapter.gracefulKillAllPtys(GRACEFUL_KILL_MS); // SIGTERM; wait for exits and final output
          // Final post-exit save. Nothing left to probe a cwd from, and each pane
          // keeps the one the save above recorded.
          await adapter.requestSessionFlush(POST_KILL_FLUSH_MS, { probeCwd: false });
          await flushWindowSession(); // the Walls' records become one Window blob
          await adapter.drainSessionSaves(DRAIN_MS); // last write reaches disk
        })(),
        QUIT_TEARDOWN_CEILING_MS,
        `[quit] teardown exceeded ${QUIT_TEARDOWN_CEILING_MS}ms; proceeding to exit`,
      );
    }
    // Install strictly after the completed final save. A fresh `quit_progress`
    // gives install its own watchdog budget instead of the teardown remainder.
    if (hasPendingUpdate()) {
      void invoke("quit_progress").catch(() => {}); // install phase begins
      await installPendingUpdate();
    }
  } catch (err) {
    // A rejecting step or a failed installer must not prevent exit.
    console.warn("[quit] teardown step failed; proceeding to exit", err);
  } finally {
    void invoke("quit_proceed").catch(() => {});
  }
}

// Abort a pending quit (confirmation cancel): Rust drops the pending quit and a
// later trigger starts fresh.
function cancelQuit(): void {
  quitPhase = "idle";
  void invoke("quit_cancel").catch(() => {});
}

/** @internal Reset module state for testing. */
export function _resetForTesting(): void {
  quitPhase = "idle";
  quitAdapter = null;
  quitConfirmGate = null;
}
