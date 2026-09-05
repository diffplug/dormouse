// Every user-visible permanent Surface closure passes through here first: the
// notes become one archive batch per Surface, all of them appended in a single
// mutation, and only then does the caller tear the Surface down
// (docs/specs/notepad.md → "Closure"). Separate from the store because the store
// is synchronous state and this is the one place that awaits the host.
import { buildArchiveBatch } from './archive-model';
import { hasNotepadArchive, mutateArchive } from './archive-service';
import {
  beginClosing,
  getNotepadSurfaceMeta,
  getNotes,
  newNotepadId,
  removeSurface,
} from './notepad-store';
import type { ArchiveBatch, LiveNote } from './types';

/** An untouched Add New is not a note. It would archive as a row nobody typed,
 *  and a Surface holding only those closes as if it held none. */
function isArchivable(note: LiveNote): boolean {
  return note.content.kind !== 'plain' || note.content.text !== '';
}

export interface ArchiveSurfaceNotesOptions {
  /** Aborted once the caller has stopped waiting for this archive (the
   *  standalone quit gate's deadline). The mutation still finishes — it may
   *  already be mid-flight — but the live notes are then left alone. */
  signal?: AbortSignal;
}

/**
 * Archive the notes of every Surface in `surfaceIds` and forget them.
 *
 * Resolves once the notes are safely stored (or there were none). Rejects with
 * the archive service's user-presentable error when the write fails, leaving
 * every note in place so the caller can offer Keep open / Close anyway rather
 * than dropping them.
 */
export async function archiveSurfaceNotes(
  surfaceIds: readonly string[],
  options?: ArchiveSurfaceNotesOptions,
): Promise<void> {
  // No archive port means no notepad on this host at all, so there is nothing
  // captured to lose and nowhere to write it — closure must not be blockable.
  const archivable = hasNotepadArchive();
  // The freeze comes before the first `getNotes`, so the batches below and the
  // notes the user can no longer touch are the same set: nothing taken during
  // the write can be archived stale or dropped by the forget step
  // (docs/specs/notepad.md → "Closure").
  const release = beginClosing(surfaceIds);
  try {
    const batches: ArchiveBatch[] = [];
    const archiving: string[] = [];
    // One closure, one instant: every batch this call appends closed together.
    const closedAt = Date.now();

    for (const surfaceId of surfaceIds) {
      const notes = getNotes(surfaceId).filter(isArchivable);
      if (!archivable || notes.length === 0) {
        // A Surface that never held a note closes without touching the archive.
        removeSurface(surfaceId);
        continue;
      }
      // The metadata is snapshotted here, before teardown: the CWD in particular
      // is only knowable while the Session is alive.
      const meta = getNotepadSurfaceMeta(surfaceId);
      batches.push(buildArchiveBatch({
        // A fresh id per call, never one remembered across a rejection: a write
        // that landed and *then* reported failure would otherwise make the next
        // closure a no-op append, silently dropping the notes added in between.
        // The compare-and-swap retry inside `mutateArchive` reuses this same
        // object, and repeat attempts are deduplicated by note id instead
        // (`applyArchiveMutation`).
        id: newNotepadId('batch'),
        closedAt,
        surfaceTitle: meta?.surfaceTitle ?? '',
        surfaceKind: meta?.surfaceKind ?? 'terminal',
        cwd: meta?.cwd ?? null,
        notes,
      }));
      archiving.push(surfaceId);
    }

    if (batches.length === 0) return;
    // One mutation for the whole closure, so a multi-Surface close (the
    // standalone quit gate) is a single read-modify-write that either lands
    // entirely or not at all.
    await mutateArchive({ append: batches });
    // Aborted means the caller gave up waiting and told the user their notes
    // were not stored — the quit was cancelled, the Surfaces are still on
    // screen, and emptying them now would delete notes in front of someone who
    // just said no. The batch is stored; note-id idempotence lets the next close
    // re-archive the same notes exactly once.
    if (options?.signal?.aborted) return;
    for (const surfaceId of archiving) removeSurface(surfaceId);
  } finally {
    // Whether the write landed or rejected, the notepad is the user's again.
    release();
  }
}
