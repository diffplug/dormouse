import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { countRunningSessions } from "dormouse-lib/lib/terminal-registry";
import type { TauriAdapter } from "./tauri-adapter";
import { hasPendingUpdate, installPendingUpdate } from "./updater";
import { withTimeout } from "./with-timeout";

/**
 * Quit orchestrator. Rust intercepts every quit trigger and emits
 * `dormouse://quit-requested`; this module acks, runs the graceful teardown,
 * and calls `quit_proceed` on every path so the app always exits. Protocol,
 * teardown ordering, and rationale: docs/specs/standalone.md §Quit flow.
 */

// One quit flow at a time: repeated quit-requested events are ignored while a
// confirmation decision is outstanding or a teardown is running.
let quitPhase: "idle" | "confirming" | "tearing-down" = "idle";
// The adapter to tear down, captured at init.
let quitAdapter: TauriAdapter | null = null;

// The quit-confirmation gate (docs/specs/standalone.md `## Future`, quit
// confirmation dialog). When quit fires with ≥1 running session and a gate is
// installed, the gate owns the decision and must eventually call
// `ctx.confirm()` (run the teardown) or `ctx.cancel()` (abort). With no gate
// installed the handler falls through to an immediate unconfirmed teardown.
export interface QuitConfirmContext {
  runningCount: number;
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

  const running = countRunningSessions();
  if (running > 0 && quitConfirmGate) {
    quitPhase = "confirming";
    quitConfirmGate({
      runningCount: running,
      confirm: () => void runQuitTeardown(),
      cancel: cancelQuit,
    });
    return;
  }
  void runQuitTeardown();
}

// Ordering and rationale: docs/specs/standalone.md §Quit flow (Teardown
// ordering). The 8s ceiling is belt-and-suspenders over the per-step bounds;
// Rust's 20s watchdog backstops this module wedging entirely.
async function runQuitTeardown(): Promise<void> {
  quitPhase = "tearing-down";
  const adapter = quitAdapter;
  try {
    if (adapter) {
      await withTimeout(
        (async () => {
          await adapter.requestSessionFlush(1500); // save while PTYs are alive
          await adapter.gracefulKillAllPtys(2000); // SIGTERM; scrollback survives
          await adapter.requestSessionFlush(1500); // capture final scrollback
          await adapter.drainSessionSaves(2000); // last write reaches disk
        })(),
        8000,
        "[quit] teardown exceeded 8000ms; proceeding to exit",
      );
    }
    // Install strictly after the completed final save.
    if (hasPendingUpdate()) await installPendingUpdate();
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
