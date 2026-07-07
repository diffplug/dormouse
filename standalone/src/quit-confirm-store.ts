import { setQuitConfirmGate, type QuitConfirmContext } from "./quit";

/**
 * Module store backing the quit-confirmation dialog (docs/specs/standalone.md
 * §Quit flow, "Confirmation dialog"). `installQuitConfirmGate` registers the
 * running-work gate on the quit orchestrator; when quit fires with ≥1 running
 * session the gate opens this store, and `<QuitConfirmModalHost>` renders off
 * its `useSyncExternalStore` snapshot. `confirm` / `cancel` delegate to the
 * orchestrator context (`ctx.confirm` runs the teardown, `ctx.cancel` invokes
 * `quit_cancel`); the store never duplicates that phase/Rust logic.
 */

export interface QuitConfirmSnapshot {
  /** Running-session count at the moment the dialog opened. The dialog's live
   *  count is read separately from the terminal registry (a command may finish
   *  while the dialog is up); this is only the trigger-time value. */
  runningCountAtRequest: number;
}

let snapshot: QuitConfirmSnapshot | null = null;
// The orchestrator context for the open request. Nulled the instant the
// decision is made, so a double-click confirm / a late cancel is a no-op.
let activeCtx: QuitConfirmContext | null = null;
const listeners = new Set<() => void>();

export function subscribeQuitConfirm(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getQuitConfirmSnapshot(): QuitConfirmSnapshot | null {
  return snapshot;
}

function emit(): void {
  for (const listener of listeners) listener();
}

// The gate: open the dialog for a running-work quit. The orchestrator already
// dedupes (`quitPhase !== "idle"`), so it never re-invokes the gate while a
// dialog is up — the `snapshot` guard is belt-and-suspenders against stacking.
function openQuitConfirm(ctx: QuitConfirmContext): void {
  if (snapshot) return;
  activeCtx = ctx;
  snapshot = { runningCountAtRequest: ctx.runningCount };
  emit();
}

/** User confirmed: run the teardown. The dialog stays mounted (snapshot is not
 *  cleared) so it can show a non-interactive "Quitting…" state; the app exits
 *  within ~1–3s. Resolving `activeCtx` blocks a second confirm/cancel. */
export function confirmQuit(): void {
  const ctx = activeCtx;
  if (!ctx) return;
  activeCtx = null;
  ctx.confirm();
}

/** User cancelled (button or Escape): close the dialog and abort the quit. The
 *  app and every terminal are left untouched; a later quit starts fresh. */
export function cancelQuit(): void {
  const ctx = activeCtx;
  if (!ctx) return;
  activeCtx = null;
  snapshot = null;
  emit();
  ctx.cancel();
}

/** Install the running-work confirmation gate on the quit orchestrator. Call
 *  once at startup, after `initQuitFlow`. */
export function installQuitConfirmGate(): void {
  setQuitConfirmGate(openQuitConfirm);
}

/** @internal Reset module state for testing. */
export function _resetQuitConfirmForTesting(): void {
  snapshot = null;
  activeCtx = null;
  listeners.clear();
}
