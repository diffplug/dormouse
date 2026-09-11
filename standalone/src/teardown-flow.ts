import { invoke } from "@tauri-apps/api/core";
import { countRunningSessions } from "dormouse-lib/lib/terminal-registry";
import { notepadSurfaceIds, removeSurface } from "dormouse-lib/lib/notepad/notepad-store";
import { getWorkspacesSnapshot } from "dormouse-lib/lib/workspace-store";
import {
  dismissQuitConfirm,
  openQuitArchiveFailure,
  type QuitConfirmIntent,
} from "./quit-confirm-store";
import { archiveNotesBeforeTeardown } from "./teardown-archive";

/**
 * The shape a quit and a per-window close share: **ack, ask, archive, act**.
 *
 * Both are the host preventing an ending, this window deciding whether to take
 * it, and the host being called back. What differs is only the last step — a
 * quit votes and waits for its turn in the walk, a close tears down there and
 * then — and the commands each names. Protocols: `docs/specs/standalone.md` →
 * "Quit flow" and "Per-window close".
 *
 * The two are separate machines over **one** window, one dialog and one human,
 * so they arbitrate: see `claim` below.
 */

export interface TeardownConfirmContext {
  confirm: () => void;
  cancel: () => void;
}

/** Puts the running-work question. Owns the decision, and must eventually call
 *  one side of the context. */
export type TeardownConfirmGate = (ctx: TeardownConfirmContext, intent: QuitConfirmIntent) => void;

export interface TeardownFlow {
  /** The host asked this window to end. Acks first, then gates. */
  request(intent: QuitConfirmIntent): void;
  /** Abort from this window (a declined dialog). */
  cancel(): void;
  /** @internal Back to idle, for a decision made elsewhere and for tests. */
  reset(): void;
}

/**
 * How a window names itself in a dialog: by the Workspace it is showing, which
 * is the only name a user has for one (`docs/specs/standalone.md` → "Quit flow",
 * Confirmation dialog).
 */
export function describeWindow(): string | undefined {
  const { workspaces, activeId } = getWorkspacesSnapshot();
  return workspaces.find((workspace) => workspace.id === activeId)?.name;
}

/**
 * The one teardown this window is running, if any.
 *
 * **A quit outranks a close, and nothing outranks a committed flow.** Both
 * machines put their question through the same single-slot dialog store and both
 * owe the host an answer, so the second one to arrive used to be dropped in
 * silence: its context never settled, and the host waited on a decision that
 * could not come. Precedence instead:
 *
 * | Arriving | Holder | Outcome |
 * |---|---|---|
 * | quit | close, undecided | the close is cancelled; the quit takes over |
 * | quit | anything committed | the quit acks **and votes** — the window is ending anyway, and a quit that never votes leaves the machine in `Voting` with no dialog anywhere |
 * | close | quit, any state | refused with `window_close_cancel`; the window stays |
 */
interface TeardownClaim {
  kind: QuitConfirmIntent["kind"];
  /** Whether the flow can still be given up: it is holding a dialog, not
   *  running a teardown. */
  undecided(): boolean;
  /** Drop the dialog and settle with the host. Only called while undecided. */
  abandon(): void;
}
let holder: TeardownClaim | null = null;

/**
 * A quit that voted on behalf of a committed holder, kept until that holder is
 * done with the window.
 *
 * **A committed flow can still retreat**: `archive-failed` puts the notes it
 * could not store to the user, and a decline there cancels the close and leaves
 * the window standing — with a quit already voted for it and its own question
 * never asked. Re-driving the quit intent is what puts that question back.
 *
 * `by` is the quit flow that registered it, `against` the holder it waits on.
 * A quit cancelled elsewhere resets `by` and must forget the entry — Rust has
 * abandoned that quit, and re-driving it later would open a dialog whose vote
 * goes into an idle machine.
 */
let deferredQuit: { by: TeardownClaim; against: TeardownClaim; rerun: () => void } | null = null;

/** @internal Forget the window-wide claim (tests). */
export function _resetTeardownArbiterForTesting(): void {
  holder = null;
  deferredQuit = null;
}

export function createTeardownFlow(options: {
  /** Which machine this is, for the arbiter's precedence. */
  kind: QuitConfirmIntent["kind"];
  /** Command that stands the host's ack watchdog down. */
  ack: string;
  /** Command that tells the host this window declined. */
  cancelCommand: string;
  /** Read at request time, never captured: the quit's gate is registered during
   *  bootstrap, in no fixed order against the flow's own wiring. */
  gate: () => TeardownConfirmGate | null;
  /** Whether this window has something to ask about. Defaults to running work. */
  mustConfirm?: () => boolean;
  /** Past both gates. A quit votes; a close runs its teardown. */
  proceed: () => void | Promise<void>;
}): TeardownFlow {
  // One flow at a time in this window: repeated triggers are ignored while a
  // confirmation is outstanding, the archive gate is asking about notes it could
  // not store, or this window has committed.
  let phase: "idle" | "confirming" | "archive-failed" | "committed" = "idle";

  const claim: TeardownClaim = {
    kind: options.kind,
    undecided: () => phase === "confirming" || phase === "archive-failed",
    abandon: () => {
      // The dialog is this flow's — the arbiter allows no other — and it is
      // dropped rather than cancelled through the store, because `cancel` below
      // is what owes the host its answer.
      dismissQuitConfirm();
      cancel();
    },
  };

  function enter(next: "confirming" | "archive-failed" | "committed"): void {
    phase = next;
    holder = claim;
  }

  const cancel = (): void => {
    phase = "idle";
    if (holder === claim) holder = null;
    void invoke(options.cancelCommand).catch(() => {});
    // This window is not ending after all, and a quit deferred to it never got
    // to ask its own question. Ask it now.
    if (deferredQuit?.against === claim) {
      const { rerun } = deferredQuit;
      deferredQuit = null;
      rerun();
    }
  };

  async function archiveThenProceed(intent: QuitConfirmIntent): Promise<void> {
    // Committed from here: the archive is an await, so without this a second
    // trigger arriving mid-archive would start a parallel flow.
    enter("committed");
    try {
      await archiveNotesBeforeTeardown();
    } catch (err) {
      // The host's wait past the ack is unbounded precisely because it waits on
      // a human, and cancelling here would retire the watchdog that a later
      // "anyway" still needs. Hold in `archive-failed`, which dedupes a repeat
      // trigger exactly as a pending confirmation does.
      enter("archive-failed");
      openQuitArchiveFailure(
        err instanceof Error ? err.message : String(err),
        {
          confirm: () => {
            // The user accepts losing these notes: forget them and take the
            // teardown that now has nothing left to archive.
            for (const id of notepadSurfaceIds()) removeSurface(id);
            enter("committed");
            void options.proceed();
          },
          cancel,
        },
        intent,
      );
      return;
    }
    await options.proceed();
  }

  const flow: TeardownFlow = {
    request(intent) {
      // Ack first — stands the host's ack watchdog down even when the trigger is
      // deduped below (a repeated trigger re-emits, so re-acking is expected).
      void invoke(options.ack).catch(() => {});
      if (phase !== "idle") return;
      if (holder && holder !== claim) {
        if (options.kind !== "quit") {
          // A close refused here is answered, never dropped: Rust is holding
          // the window open on a `prevent_close` waiting for exactly this.
          cancel();
          return;
        }
        if (!holder.undecided()) {
          // The holder has committed: this window is being torn down whatever
          // the quit decides, so the quit takes it as a yes rather than saying
          // nothing — a window that never votes holds the whole app in `Voting`
          // with no dialog for the user to answer. Kept, in case that holder
          // retreats and is cancelled (`deferredQuit`).
          deferredQuit = { by: claim, against: holder, rerun: () => flow.request(intent) };
          void options.proceed();
          return;
        }
        holder.abandon();
        // Abandoning a holder that retreated re-drives the quit deferred to it —
        // re-entering this `request` from inside the holder's `cancel`, with
        // the intent already gated by the time control returns here. Gating it
        // again would open a second dialog into the store's refusal, whose
        // `cancel` aborts the whole quit under the dialog the rerun opened.
        if (phase !== "idle") return;
      }

      // The registry is per webview, so this is already this window's own work.
      const gate = options.gate();
      const mustConfirm = options.mustConfirm ?? (() => countRunningSessions() > 0);
      if (mustConfirm() && gate) {
        enter("confirming");
        gate({ confirm: () => void archiveThenProceed(intent), cancel }, intent);
        return;
      }
      void archiveThenProceed(intent);
    },
    cancel,
    reset() {
      phase = "idle";
      if (holder === claim) holder = null;
      if (deferredQuit?.by === claim || deferredQuit?.against === claim) deferredQuit = null;
    },
  };
  return flow;
}
