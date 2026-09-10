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
 * | quit | anything committed | the quit only acks — the window is ending, and Rust forgets it when it is destroyed |
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

/** @internal Forget the window-wide claim (tests). */
export function _resetTeardownArbiterForTesting(): void {
  holder = null;
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

  return {
    request(intent) {
      // Ack first — stands the host's ack watchdog down even when the trigger is
      // deduped below (a repeated trigger re-emits, so re-acking is expected).
      void invoke(options.ack).catch(() => {});
      if (phase !== "idle") return;
      if (holder && holder !== claim) {
        if (options.kind !== "quit" || !holder.undecided()) {
          // A close refused here is answered, never dropped: Rust is holding
          // the window open on a `prevent_close` waiting for exactly this.
          // A quit refused here says nothing — `quit_cancel` would abort the
          // whole app's quit on behalf of a window that is already ending.
          if (options.kind !== "quit") cancel();
          return;
        }
        holder.abandon();
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
    },
  };
}
