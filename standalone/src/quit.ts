import { invoke } from "@tauri-apps/api/core";
import { countRunningSessions } from "dormouse-lib/lib/terminal-registry";
import { notepadSurfaceIds, removeSurface } from "dormouse-lib/lib/notepad/notepad-store";
import { flushWindowSession } from "dormouse-lib/lib/window-session-aggregator";
import { DEFAULT_RECOVERY_WAIT_MS } from "dormouse-lib/host/recovery-capture";
import type { TauriAdapter } from "./tauri-adapter";
import { dismissQuitConfirm, openQuitArchiveFailure, type QuitConfirmIntent } from "./quit-confirm-store";
import { archiveNotesBeforeTeardown } from "./teardown-archive";
import { hasPendingUpdate, installPendingUpdate } from "./updater";
import { withTimeout } from "./with-timeout";
import { listenToWindow } from "./window-label";

/**
 * Quit orchestrator — this window's half of it.
 *
 * Rust intercepts every quit trigger and asks every window to **vote**; only
 * once they all agree does it **walk** them, one teardown at a time, `main`
 * last. A cancel in any window therefore costs nothing, because nothing has
 * been destroyed yet. Protocol, teardown ordering, and rationale:
 * docs/specs/standalone.md §Quit flow.
 */

// One quit flow at a time in this window: repeated quit-requested events are
// ignored while a confirmation decision is outstanding, the archive gate is
// asking about notes it could not store, this window has already voted, or its
// teardown is running.
let quitPhase: "idle" | "confirming" | "archive-failed" | "voted" | "tearing-down" = "idle";
// The adapter to tear down, captured at init.
let quitAdapter: TauriAdapter | null = null;
/** Names this window in the dialog while more than one is open. */
let describeWindow: () => string | undefined = () => undefined;

// The quit-confirmation gate (docs/specs/standalone.md §Quit flow,
// "Confirmation dialog"). When quit fires with ≥1 running session and a gate is
// installed, the gate owns the decision and must eventually call
// `ctx.confirm()` (vote to quit) or `ctx.cancel()` (abort the whole quit). With
// no gate installed the handler falls through to an immediate unconfirmed vote.
export interface QuitConfirmContext {
  confirm: () => void;
  cancel: () => void;
}
type QuitConfirmGate = (ctx: QuitConfirmContext, intent?: QuitConfirmIntent) => void;
let quitConfirmGate: QuitConfirmGate | null = null;

/** Register (or clear with null) the running-work confirmation gate. */
export function setQuitConfirmGate(gate: QuitConfirmGate | null): void {
  quitConfirmGate = gate;
}

export function initQuitFlow(
  adapter: TauriAdapter,
  options: { windowName?: () => string | undefined } = {},
): void {
  quitAdapter = adapter;
  if (options.windowName) describeWindow = options.windowName;
  void listenToWindow<{ windows?: number }>("dormouse://quit-requested", (event) =>
    handleQuitRequested(event.payload?.windows ?? 1));
  // Another window said no. Nothing was destroyed; drop this window's dialog
  // and go back to idle so a later quit asks again.
  void listenToWindow("dormouse://quit-cancelled", handleQuitCancelled);
  // Every window voted yes, and it is now this window's turn.
  void listenToWindow<{ last?: boolean }>("dormouse://quit-teardown", (event) => {
    void runQuitTeardown(event.payload?.last === true);
  });
}

function handleQuitRequested(windows: number): void {
  // Ack first — stands Rust's ack watchdog down even when the trigger is
  // deduped below (a repeated trigger re-emits, so re-acking is expected).
  void invoke("quit_ack").catch(() => {});

  if (quitPhase !== "idle") return;

  if (countRunningSessions() > 0 && quitConfirmGate) {
    quitPhase = "confirming";
    quitConfirmGate(
      { confirm: () => void archiveThenVote(), cancel: cancelQuit },
      // Named only when there is more than one window to tell apart.
      { kind: "quit", ...(windows > 1 ? { windowName: describeWindow() } : {}) },
    );
    return;
  }
  void archiveThenVote();
}

// The decision is made in this window; archive its notes, then vote. A refused
// archive is the one thing that stops it, and only until the user answers.
async function archiveThenVote(): Promise<void> {
  // Committed from here: the gate is an await, so without this a second trigger
  // arriving mid-archive would start a parallel flow.
  quitPhase = "voted";
  try {
    await archiveNotesBeforeTeardown();
  } catch (err) {
    // The quit stays pending in Rust. Its wait past the ack is unbounded
    // precisely because it waits on a human (docs/specs/standalone.md → "Quit
    // flow"), and cancelling here would retire the watchdog that a later Quit
    // anyway still needs. Hold the flow in `archive-failed` so a repeat trigger
    // is deduped exactly like a pending confirmation.
    quitPhase = "archive-failed";
    openQuitArchiveFailure(err instanceof Error ? err.message : String(err), {
      confirm: () => {
        // Quit anyway: the user accepts losing these notes, so forget them and
        // vote — watchdog still armed, because nothing cancelled the quit.
        for (const id of notepadSurfaceIds()) removeSurface(id);
        castVote();
      },
      // Cancel is the one branch that drops the pending quit in Rust.
      cancel: cancelQuit,
    });
    return;
  }
  castVote();
}

function castVote(): void {
  quitPhase = "voted";
  void invoke("quit_vote").catch(() => {});
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
// ordering). `quit_progress` marks each phase boundary so Rust's watchdog gives
// teardown and install separate budgets rather than one shared clock.
//
// Every host step here is scoped to this window by Rust — the capture, the kill
// and the snapshot are all keyed by the invoking window's label — so a window
// tearing down can neither interrupt nor kill a sibling's terminals.
async function runQuitTeardown(last: boolean): Promise<void> {
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
          await adapter.captureAgentRecovery(DEFAULT_RECOVERY_WAIT_MS).catch((err) =>
            console.warn("[quit] agent recovery capture failed; proceeding", err));
          await adapter.requestSessionFlush(PRE_KILL_FLUSH_MS); // save while PTYs are alive
          await adapter.gracefulKillPtys(GRACEFUL_KILL_MS); // SIGTERM; wait for exits and final output
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
    // Install strictly after the completed final save, and only in the window
    // the walk tears down last — `main`, the only one granted `updater:*`
    // (docs/specs/auto-update.md). A fresh `quit_progress` gives install its own
    // watchdog budget instead of the teardown remainder.
    if (last && hasPendingUpdate()) {
      void invoke("quit_progress").catch(() => {}); // install phase begins
      await installPendingUpdate();
    }
  } catch (err) {
    // A rejecting step or a failed installer must not prevent exit.
    console.warn("[quit] teardown step failed; proceeding", err);
  } finally {
    // The last window exits the app; every other one is destroyed and hands the
    // walk on to the next.
    void invoke(last ? "quit_proceed" : "quit_window_done").catch(() => {});
  }
}

// Abort the whole quit from this window (confirmation cancel). Rust tells every
// window, and nothing anywhere has been destroyed.
function cancelQuit(): void {
  quitPhase = "idle";
  void invoke("quit_cancel").catch(() => {});
}

// Rust says some window declined. Drop this window's dialog without calling
// back into Rust — the cancel already happened, somewhere else.
function handleQuitCancelled(): void {
  quitPhase = "idle";
  dismissQuitConfirm();
}

/** @internal Reset module state for testing. */
export function _resetForTesting(): void {
  quitPhase = "idle";
  quitAdapter = null;
  quitConfirmGate = null;
  describeWindow = () => undefined;
}
