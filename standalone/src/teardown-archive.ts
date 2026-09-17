import { archiveSurfaceNotes } from "dormouse-lib/lib/notepad/close-coordinator";
import { notepadSurfaceIds } from "dormouse-lib/lib/notepad/notepad-store";
import { withDeadline } from "./with-timeout";

/**
 * The notepad gate both deliberate endings share: a quit and a per-window close
 * (`docs/specs/notepad.md` → "Standalone quit"). A Workspace *transfer* is not
 * one of them — a move is not a closure, so it archives nothing.
 *
 * The registry is per webview, so `notepadSurfaceIds()` is already this
 * window's Surfaces and nothing else's.
 */

// The archive write is a host round trip; a wedged one must not hold the
// teardown open, so it gets its own bound ahead of the teardown's.
export const ARCHIVE_GATE_MS = 3000;

/**
 * Archive every Surface holding notes or a pending batch identity, in one
 * mutation, after the running-work decision and before teardown begins.
 * Rejects with a user-presentable message when the write fails or outruns its
 * bound — the caller turns that into Cancel / proceed anyway.
 */
export async function archiveNotesBeforeTeardown(): Promise<void> {
  const ids = notepadSurfaceIds();
  if (ids.length === 0) return;
  // The deadline only stops us *waiting*; the archive itself keeps running and
  // may still succeed. The signal is what stops it emptying every notepad
  // afterwards, behind a user who has been told their notes were not stored and
  // has chosen Cancel.
  const gaveUp = new AbortController();
  try {
    await withDeadline(
      archiveSurfaceNotes(ids, { signal: gaveUp.signal }),
      ARCHIVE_GATE_MS,
      `The notepad archive did not finish within ${ARCHIVE_GATE_MS / 1000}s.`,
    );
  } catch (err) {
    gaveUp.abort();
    throw err;
  }
}
