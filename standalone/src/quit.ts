import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { countRunningSessions } from "dormouse-lib/lib/terminal-registry";
import { archiveSurfaceNotes } from "dormouse-lib/lib/notepad/close-coordinator";
import { notepadSurfaceIds, removeSurface } from "dormouse-lib/lib/notepad/notepad-store";
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
 * Surface still holding notes is archived in one mutation, after the running-work
 * decision and before teardown begins, so a controlled quit never drops notes.
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

// Ordering and rationale: docs/specs/standalone.md §Quit flow (Teardown
// ordering). The 8s ceiling is belt-and-suspenders over the per-step bounds.
// `quit_progress` tells Rust teardown has begun (ending the confirmation-wait
// suspension) and marks each phase boundary so its watchdog gives teardown and
// install separate budgets rather than one shared clock.
async function runQuitTeardown(): Promise<void> {
  quitPhase = "tearing-down";
  const adapter = quitAdapter;
  try {
    void invoke("quit_progress").catch(() => {}); // teardown phase begins
    if (adapter) {
      await withTimeout(
        (async () => {
          // The two flushes are near-free while standalone persists nothing —
          // `saveSession` returns immediately on `persistsSession: false`, so
          // neither one runs a `getCwd` round trip. The shape is kept because
          // the ordering is the load-bearing part and the workspaces-rollout
          // scope turns persistence back on (docs/specs/layout.md -> `## Future`).
          await adapter.requestSessionFlush(1500); // save while PTYs are alive
          await adapter.gracefulKillAllPtys(2000); // SIGTERM; wait for exits and final output
          await adapter.requestSessionFlush(1500); // final post-exit save
          await adapter.drainSessionSaves(2000); // last write reaches disk
        })(),
        8000,
        "[quit] teardown exceeded 8000ms; proceeding to exit",
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
