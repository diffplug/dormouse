import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { countRunningSessions } from "dormouse-lib/lib/terminal-registry";
import type { TauriAdapter } from "./tauri-adapter";
import { hasPendingUpdate, installPendingUpdate } from "./updater";

/**
 * Quit orchestrator (docs/specs/standalone.md §Quit flow).
 *
 * Rust intercepts every quit trigger (window close, Cmd+Q, dock quit, OS logout)
 * and emits `dormouse://quit-requested` instead of exiting. This module answers
 * that event: it acks (standing down Rust's phase-1 watchdog), runs a graceful
 * teardown — flush while PTYs are alive, SIGTERM them, capture their final
 * scrollback, drain the last save, then install any pending update — and finally
 * calls `quit_proceed`, which lets Rust exit. Every path ends in `quit_proceed`
 * so the app always exits, even on error/timeout; Rust's 20 s watchdog is the
 * outer backstop if this module wedges entirely.
 */

// Teardown is running: repeated quit-requested events are ignored so a second
// trigger can't restart it.
let tearingDown = false;
// A confirm decision is outstanding (a stage-D3 gate is showing its dialog):
// ignore further triggers until the user decides.
let confirmPending = false;
// The adapter to tear down, captured at init. Module-level so runQuitTeardown
// and the confirm callbacks can all reach it.
let quitAdapter: TauriAdapter | null = null;

// ── Stage-D3 confirmation seam ───────────────────────────────────────────────
//
// When quit is triggered with ≥1 running session, stage D3 will show a
// confirmation dialog. It registers a gate here; the gate owns the decision and
// must eventually call `ctx.confirm()` (run the teardown) or `ctx.cancel()`
// (abort — invokes quit_cancel). Until a gate is installed, the handler below
// falls through to an immediate, unconfirmed teardown — today's behavior.
export interface QuitConfirmContext {
  runningCount: number;
  confirm: () => void;
  cancel: () => void;
}
type QuitConfirmGate = (ctx: QuitConfirmContext) => void;
let quitConfirmGate: QuitConfirmGate | null = null;

/** Stage D3: register (or clear with null) the running-work confirmation gate. */
export function setQuitConfirmGate(gate: QuitConfirmGate | null): void {
  quitConfirmGate = gate;
}

export function initQuitFlow(adapter: TauriAdapter): void {
  quitAdapter = adapter;
  void listen("dormouse://quit-requested", () => {
    void handleQuitRequested();
  });
}

async function handleQuitRequested(): Promise<void> {
  // Always ack first (fire-and-catch) so Rust's phase-1 watchdog stands down
  // even if we then dedupe out. A repeated trigger re-emits, so re-acking is
  // fine.
  void invoke("quit_ack").catch(() => {});

  // Dedupe: never stack teardowns or confirmation flows.
  if (tearingDown) return;
  if (confirmPending) return;

  const running = countRunningSessions();
  if (running === 0) {
    void runQuitTeardown();
    return;
  }

  // ≥1 running session. Stage D3 installs a gate that confirms with the user;
  // until then we fall through to an immediate teardown (unconfirmed, as today).
  if (quitConfirmGate) {
    confirmPending = true;
    quitConfirmGate({
      runningCount: running,
      confirm: () => {
        confirmPending = false;
        void runQuitTeardown();
      },
      cancel: cancelQuit,
    });
    return;
  }
  void runQuitTeardown();
}

async function runQuitTeardown(): Promise<void> {
  tearingDown = true;
  const adapter = quitAdapter;
  try {
    if (adapter) {
      // Bounded so a stalled step can't hold quit past this budget; each step is
      // itself bounded, this is the belt-and-suspenders ceiling.
      await withTimeout(
        8000,
        (async () => {
          // (1) Save while PTYs are alive so CWDs are fresh.
          await adapter.requestSessionFlush(1500);
          // (2) SIGTERM every PTY; resolves early once all exit. Scrollback is
          //     preserved (only a hard kill / sidecar exit clears the buffer).
          await adapter.gracefulKillAllPtys(2000);
          // (3) Capture the final scrollback of the now-dead PTYs (their buffers
          //     survive; getCwd returns null → session-save keeps the prior CWD).
          await adapter.requestSessionFlush(1500);
          // (4) Await the last save_session write reaching disk — the Thread C
          //     durability guarantee.
          await adapter.drainSessionSaves(2000);
        })(),
      );
    }
    // (5) Install strictly AFTER the completed final save (auto-update.md
    //     ordering; Rust's 20 s watchdog backstops a hung installer).
    if (hasPendingUpdate()) await installPendingUpdate();
  } catch (err) {
    // A rejecting step or a failed installer must not prevent exit.
    console.warn("[quit] teardown step failed; proceeding to exit", err);
  } finally {
    // (6) Always — even on throw/timeout — hand control back to Rust to exit.
    void invoke("quit_proceed").catch(() => {});
  }
}

/**
 * Abort a quit in flight (stage D3 confirmation cancel). Tells Rust to drop the
 * pending quit and resets local flags so a later trigger starts fresh.
 */
export function cancelQuit(): void {
  tearingDown = false;
  confirmPending = false;
  void invoke("quit_cancel").catch(() => {});
}

// Resolve (never reject) when either `work` settles or `ms` elapses, clearing the
// timer when the work wins. A timeout only logs and resolves — it never rejects
// — so quit proceeds regardless.
function withTimeout(ms: number, work: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[quit] teardown exceeded ${ms}ms; proceeding to exit`);
      resolve();
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** @internal Reset module state for testing. */
export function _resetForTesting(): void {
  tearingDown = false;
  confirmPending = false;
  quitAdapter = null;
  quitConfirmGate = null;
}
