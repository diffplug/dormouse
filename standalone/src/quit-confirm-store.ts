import { randomKillChar } from '../../lib/src/components/KillConfirm';
import { acquireChromeKeyboardLease } from '../../lib/src/components/wall/chrome-keyboard-lease';
import { getWorkspacesSnapshot, subscribeToWorkspaces } from 'dormouse-lib/lib/workspace-store';
import { resetWorkspaceUi } from 'dormouse-lib/lib/workspace-ui-store';
import type { TeardownConfirmContext } from "./teardown-flow";

/**
 * Module store backing the quit-confirmation dialog. The quit orchestrator's
 * gate (`openQuitConfirm`, wired via `setQuitConfirmGate` in bootstrap) opens
 * it; `<WorkspaceTeardownModalHost>` renders off the phase. Behavior:
 * docs/specs/standalone.md §Quit flow, "Confirmation dialog".
 */

export type QuitConfirmPhase = "open" | "quitting" | "archive-failed";

/**
 * What the dialog is asking about. A quit tears every window down; a
 * close ends this one alone (docs/specs/standalone.md §Per-window close). The
 * affected Workspace names are captured separately by this store.
 */
export interface QuitConfirmIntent {
  kind: "quit" | "close-window";
  /** This window holds an approved, downloaded update that closing throws away:
   *  the download lives in the webview, so nothing else can install it
   *  (docs/specs/auto-update.md). Never set on a quit, which installs it. */
  discardsUpdate?: boolean;
  /** This quit relaunches the app once it exits, and `requester` is the
   *  Surface that asked, which never counts as running work here
   *  (docs/specs/standalone.md → "Restart"). Only ever set on a quit. */
  restart?: boolean;
  requester?: string | null;
}

const QUIT_INTENT: QuitConfirmIntent = { kind: "quit" };

let phase: QuitConfirmPhase | null = null;
let intent: QuitConfirmIntent = QUIT_INTENT;
// Why the archive gate refused the quit; only set alongside "archive-failed".
let archiveError: string | null = null;
// The orchestrator context for the open request. Nulled the instant a decision
// is made, so a repeated confirm / a late cancel is a no-op.
let activeCtx: TeardownConfirmContext | null = null;
const listeners = new Set<() => void>();
let confirmChar = '';
let workspaceNames: readonly string[] = [];
let releaseKeyboard: (() => void) | null = null;
let unsubscribeWorkspaces: (() => void) | null = null;

export function getQuitConfirmChar(): string { return confirmChar; }
export function getQuitConfirmWorkspaceNames(): readonly string[] { return workspaceNames; }

function stopWatchingWorkspaces(): void {
  unsubscribeWorkspaces?.();
  unsubscribeWorkspaces = null;
}

function releaseDialog(): void {
  stopWatchingWorkspaces();
  releaseKeyboard?.();
  releaseKeyboard = null;
}

function ownDialog(): void {
  releaseKeyboard ??= acquireChromeKeyboardLease();
  // Clear competing typed gates; in-flight transfer guards live elsewhere.
  resetWorkspaceUi();
}

function captureWorkspaces(): void {
  const workspaces = getWorkspacesSnapshot().workspaces;
  workspaceNames = workspaces.map((workspace) => workspace.name);
  const ids = new Set(workspaces.map((workspace) => workspace.id));
  unsubscribeWorkspaces = subscribeToWorkspaces(() => {
    const current = getWorkspacesSnapshot().workspaces;
    // A changed destination invalidates consent; focus, rename and order do not.
    // Every exit from 'open' stops this watch, so no phase check is needed.
    if (current.length !== ids.size || current.some((workspace) => !ids.has(workspace.id))) {
      cancelQuit();
    }
  });
}

export function subscribeQuitConfirm(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getQuitConfirmPhase(): QuitConfirmPhase | null {
  return phase;
}

/** The archive error backing the "archive-failed" phase; null in every other. */
export function getQuitArchiveError(): string | null {
  return archiveError;
}

/** What the open dialog is asking about. */
export function getQuitConfirmIntent(): QuitConfirmIntent {
  return intent;
}

function emit(): void {
  for (const listener of listeners) listener();
}

// The orchestrator's confirmation gate. Wire with `setQuitConfirmGate` during
// bootstrap (order relative to `initQuitFlow` is irrelevant — the gate is read
// only at quit time). The orchestrator never re-invokes it while a dialog is
// up; the phase guard is belt-and-suspenders against stacking.
export function openQuitConfirm(ctx: TeardownConfirmContext, next: QuitConfirmIntent = QUIT_INTENT): void {
  if (phase !== null) {
    // **Never leave a refused context unsettled.** Its flow would sit in
    // `confirming` for the life of the window, and the host would wait out its
    // budget on a decision that can never arrive. The arbiter in
    // `teardown-flow.ts` should have kept this from happening at all.
    ctx.cancel();
    return;
  }
  activeCtx = ctx;
  intent = next;
  confirmChar = randomKillChar();
  phase = "open";
  ownDialog();
  captureWorkspaces();
  emit();
}

/** Own the window before archiving or voting, including an all-idle request. */
export function beginQuitProgress(next: QuitConfirmIntent): void {
  stopWatchingWorkspaces();
  activeCtx = null;
  intent = next;
  archiveError = null;
  phase = 'quitting';
  ownDialog();
  emit();
}

/**
 * The archive gate refused the quit (docs/specs/notepad.md → "Standalone
 * quit"). Reached either from "quitting" — the user already confirmed and the
 * gate ran behind the dialog — or from no dialog at all, since an all-idle quit
 * archives without ever showing one. So, unlike `openQuitConfirm`, this is not
 * guarded on an empty phase: it is always a transition from a decision already
 * made. `ctx.confirm()` is Quit anyway (notes discarded); `ctx.cancel()` closes.
 */
export function openQuitArchiveFailure(
  message: string,
  ctx: TeardownConfirmContext,
  next: QuitConfirmIntent = QUIT_INTENT,
): void {
  stopWatchingWorkspaces();
  activeCtx = ctx;
  intent = next;
  ownDialog();
  archiveError = message;
  phase = "archive-failed";
  emit();
}

// The phase survives confirm (as "quitting") so the modal shows a disabled
// quitting state until the app exits.
export function confirmQuit(): void {
  const ctx = activeCtx;
  if (!ctx) return;
  stopWatchingWorkspaces();
  activeCtx = null;
  archiveError = null;
  phase = "quitting";
  emit();
  ctx.confirm();
}

export function cancelQuit(): void {
  const ctx = activeCtx;
  if (!ctx) return;
  releaseDialog();
  activeCtx = null;
  archiveError = null;
  phase = null;
  emit();
  ctx.cancel();
}

/**
 * Drop the dialog because the decision was made somewhere else — another window
 * cancelled the quit for everyone (docs/specs/standalone.md §Quit flow). Unlike
 * `cancelQuit` it does NOT call back into the orchestrator: the cancel has
 * already happened, and calling back would bounce it around the windows.
 */
export function dismissQuitConfirm(kind?: QuitConfirmIntent["kind"]): void {
  if (phase === null) return;
  // A quit cancelled elsewhere says nothing about this window's own close.
  if (kind !== undefined && intent.kind !== kind) return;
  releaseDialog();
  activeCtx = null;
  archiveError = null;
  phase = null;
  intent = QUIT_INTENT;
  emit();
}

/** @internal Reset module state for testing. */
export function _resetQuitConfirmForTesting(): void {
  releaseDialog();
  confirmChar = '';
  workspaceNames = [];
  phase = null;
  intent = QUIT_INTENT;
  activeCtx = null;
  archiveError = null;
  listeners.clear();
}
