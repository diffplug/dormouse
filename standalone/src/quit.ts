import { invoke } from "@tauri-apps/api/core";
import { flushWindowSession } from "dormouse-lib/lib/window-session-aggregator";
import { DEFAULT_RECOVERY_WAIT_MS } from "dormouse-lib/host/recovery-capture";
import type { TauriAdapter } from "./tauri-adapter";
import { dismissQuitConfirm } from "./quit-confirm-store";
import { createTeardownFlow, describeWindow, type TeardownConfirmGate } from "./teardown-flow";
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
 *
 * The ack / confirm / archive half is `createTeardownFlow`, shared with the
 * per-window close; what is quit-specific is voting, and the teardown below.
 */

// The adapter to tear down, captured at init.
let quitAdapter: TauriAdapter | null = null;

// The quit-confirmation gate (docs/specs/standalone.md §Quit flow,
// "Confirmation dialog"). When quit fires with ≥1 running session and a gate is
// installed, the gate owns the decision and must eventually call
// `ctx.confirm()` (vote to quit) or `ctx.cancel()` (abort the whole quit). With
// no gate installed the handler falls through to an immediate unconfirmed vote —
// which is what a composition with no dialog host gets.
let quitConfirmGate: TeardownConfirmGate | null = null;

/** Register (or clear with null) the running-work confirmation gate. */
export function setQuitConfirmGate(gate: TeardownConfirmGate | null): void {
  quitConfirmGate = gate;
}

const flow = createTeardownFlow({
  kind: "quit",
  ack: "quit_ack",
  cancelCommand: "quit_cancel",
  gate: () => quitConfirmGate,
  // This window is ready to be torn down. The last vote starts the walk; the
  // teardown itself arrives later, when the walk reaches this window.
  proceed: () => void invoke("quit_vote").catch(() => {}),
});

export function initQuitFlow(adapter: TauriAdapter): void {
  quitAdapter = adapter;
  void listenToWindow<{ windows?: number }>("dormouse://quit-requested", (event) => {
    const windows = event.payload?.windows ?? 1;
    // Named only when there is more than one window to tell apart.
    flow.request({ kind: "quit", ...(windows > 1 ? { windowName: describeWindow() } : {}) });
  });
  // Another window said no. Nothing was destroyed; drop this window's dialog
  // and go back to idle so a later quit asks again. No call back into Rust —
  // the cancel already happened, somewhere else.
  void listenToWindow("dormouse://quit-cancelled", () => {
    flow.reset();
    // Only a quit's dialog: this window may instead be asking about its own
    // close, which another window's decision has no say over.
    dismissQuitConfirm("quit");
  });
  // Every window voted yes, and it is now this window's turn.
  void listenToWindow<{ last?: boolean }>("dormouse://quit-teardown", (event) => {
    void runQuitTeardown(event.payload?.last === true);
  });
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
// The Window write is synchronous on both standalone adapters today, but the
// step is bounded on what the writer may return, not on what it happens to be.
const WINDOW_WRITE_MS = 1000;
const DRAIN_MS = 2000;
const STEP_BUDGET_TOTAL_MS =
  (DEFAULT_RECOVERY_WAIT_MS + SIDECAR_ROUND_TRIP_MARGIN_MS) +
  PRE_KILL_FLUSH_MS +
  (GRACEFUL_KILL_MS + SIDECAR_ROUND_TRIP_MARGIN_MS) +
  POST_KILL_FLUSH_MS +
  WINDOW_WRITE_MS +
  DRAIN_MS;
/** Belt-and-suspenders over the summed step budgets, with slack for scheduling.
 *  Stays under Rust's `QUIT_PHASE_TIMEOUT_MS`, which is what actually forces the
 *  exit; `lib/src/lib/mirrored-constants.test.ts` reads this derivation out of
 *  the source and pins it under the Rust constant, and pins the margin above to
 *  the two Rust call sites that add it. */
const QUIT_TEARDOWN_CEILING_MS = STEP_BUDGET_TOTAL_MS + 1000;

// Ordering and rationale: docs/specs/standalone.md §Quit flow (Teardown
// ordering). `quit_progress` marks each phase boundary so Rust's watchdog gives
// teardown and install separate budgets rather than one shared clock.
//
// Every host step here is scoped to this window by Rust — the capture, the kill
// and the snapshot are all keyed by the invoking window's label — so a window
// tearing down can neither interrupt nor kill a sibling's terminals.
async function runQuitTeardown(last: boolean): Promise<void> {
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
          // The Walls' records become one Window blob. Bounded like the rest, so
          // a writer that stalls cannot eat the drain's budget behind it.
          await withTimeout(
            flushWindowSession(),
            WINDOW_WRITE_MS,
            `[quit] Window write exceeded ${WINDOW_WRITE_MS}ms; proceeding to drain`,
          );
          await adapter.drainSessionSaves(DRAIN_MS); // last write reaches disk
        })(),
        QUIT_TEARDOWN_CEILING_MS,
        `[quit] teardown exceeded ${QUIT_TEARDOWN_CEILING_MS}ms; proceeding to exit`,
      );
    }
    // Install strictly after the completed final save, and only in `main` —
    // the window the walk tears down last, and the only one holding `updater:*`
    // (`capabilities/main-only.json`; docs/specs/auto-update.md). A fresh
    // `quit_progress` gives install its own watchdog budget instead of the
    // teardown remainder.
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

/** @internal Reset module state for testing. */
export function _resetForTesting(): void {
  flow.reset();
  quitAdapter = null;
  quitConfirmGate = null;
}
