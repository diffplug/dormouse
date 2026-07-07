import type { QuitConfirmContext } from "./quit";

/**
 * Module store backing the quit-confirmation dialog. The quit orchestrator's
 * gate (`openQuitConfirm`, wired via `setQuitConfirmGate` in bootstrap) opens
 * it; `<QuitConfirmModalHost>` renders off the phase. Behavior:
 * docs/specs/standalone.md §Quit flow, "Confirmation dialog".
 */

export type QuitConfirmPhase = "open" | "quitting";

let phase: QuitConfirmPhase | null = null;
// The orchestrator context for the open request. Nulled the instant a decision
// is made, so a repeated confirm / a late cancel is a no-op.
let activeCtx: QuitConfirmContext | null = null;
const listeners = new Set<() => void>();

export function subscribeQuitConfirm(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getQuitConfirmPhase(): QuitConfirmPhase | null {
  return phase;
}

function emit(): void {
  for (const listener of listeners) listener();
}

// The orchestrator's confirmation gate. Wire with `setQuitConfirmGate` during
// bootstrap (order relative to `initQuitFlow` is irrelevant — the gate is read
// only at quit time). The orchestrator never re-invokes it while a dialog is
// up; the phase guard is belt-and-suspenders against stacking.
export function openQuitConfirm(ctx: QuitConfirmContext): void {
  if (phase !== null) return;
  activeCtx = ctx;
  phase = "open";
  emit();
}

// The phase survives confirm (as "quitting") so the modal shows a disabled
// quitting state until the app exits.
export function confirmQuit(): void {
  const ctx = activeCtx;
  if (!ctx) return;
  activeCtx = null;
  phase = "quitting";
  emit();
  ctx.confirm();
}

export function cancelQuit(): void {
  const ctx = activeCtx;
  if (!ctx) return;
  activeCtx = null;
  phase = null;
  emit();
  ctx.cancel();
}

/** @internal Reset module state for testing. */
export function _resetQuitConfirmForTesting(): void {
  phase = null;
  activeCtx = null;
  listeners.clear();
}
