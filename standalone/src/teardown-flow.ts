import { invoke } from "@tauri-apps/api/core";
import { countRunningSessions } from "dormouse-lib/lib/terminal-registry";
import { notepadSurfaceIds, removeSurface } from "dormouse-lib/lib/notepad/notepad-store";
import { getWorkspacesSnapshot } from "dormouse-lib/lib/workspace-store";
import { openQuitArchiveFailure, type QuitConfirmIntent } from "./quit-confirm-store";
import { archiveNotesBeforeTeardown } from "./teardown-archive";

/**
 * The shape a quit and a per-window close share: **ack, ask, archive, act**.
 *
 * Both are the host preventing an ending, this window deciding whether to take
 * it, and the host being called back. What differs is only the last step — a
 * quit votes and waits for its turn in the walk, a close tears down there and
 * then — and the commands each names. Protocols: `docs/specs/standalone.md` →
 * "Quit flow" and "Per-window close".
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

export function createTeardownFlow(options: {
  /** Command that stands the host's ack watchdog down. */
  ack: string;
  /** Command that tells the host this window declined. */
  cancelCommand: string;
  /** Read at request time, never captured: the quit's gate is registered during
   *  bootstrap, in no fixed order against the flow's own wiring. */
  gate: () => TeardownConfirmGate | null;
  /** Past both gates. A quit votes; a close runs its teardown. */
  proceed: () => void | Promise<void>;
}): TeardownFlow {
  // One flow at a time in this window: repeated triggers are ignored while a
  // confirmation is outstanding, the archive gate is asking about notes it could
  // not store, or this window has committed.
  let phase: "idle" | "confirming" | "archive-failed" | "committed" = "idle";

  const cancel = (): void => {
    phase = "idle";
    void invoke(options.cancelCommand).catch(() => {});
  };

  async function archiveThenProceed(intent: QuitConfirmIntent): Promise<void> {
    // Committed from here: the archive is an await, so without this a second
    // trigger arriving mid-archive would start a parallel flow.
    phase = "committed";
    try {
      await archiveNotesBeforeTeardown();
    } catch (err) {
      // The host's wait past the ack is unbounded precisely because it waits on
      // a human, and cancelling here would retire the watchdog that a later
      // "anyway" still needs. Hold in `archive-failed`, which dedupes a repeat
      // trigger exactly as a pending confirmation does.
      phase = "archive-failed";
      openQuitArchiveFailure(
        err instanceof Error ? err.message : String(err),
        {
          confirm: () => {
            // The user accepts losing these notes: forget them and take the
            // teardown that now has nothing left to archive.
            for (const id of notepadSurfaceIds()) removeSurface(id);
            phase = "committed";
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

      // The registry is per webview, so this is already this window's own work.
      const gate = options.gate();
      if (countRunningSessions() > 0 && gate) {
        phase = "confirming";
        gate({ confirm: () => void archiveThenProceed(intent), cancel }, intent);
        return;
      }
      void archiveThenProceed(intent);
    },
    cancel,
    reset() {
      phase = "idle";
    },
  };
}
