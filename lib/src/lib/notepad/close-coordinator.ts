// Every user-visible permanent Surface closure passes through here first: the
// notes become one archive batch per Surface, all of them appended in a single
// mutation, and only then does the caller tear the Surface down
// (docs/specs/notepad.md → "Closure"). Separate from the store because the store
// is synchronous state and this is the one place that awaits the host.
import { hasTerminal } from 'dor/commands/types';
import { getPlatformOrNull } from '../platform';
import { settleAllWithin } from '../settle-within';
import { processCwdMayReplace } from '../terminal-state';
import { fillTerminalProcessCwd } from '../terminal-state-store';
import { buildArchiveBatch } from './archive-model';
import { hasNotepadArchive, mutateArchive } from './archive-service';
import {
  beginClosing,
  getNotepadSurfaceMeta,
  getNotes,
  isEmptyPlainNote,
  peekPendingBatchId,
  pendingBatchId,
  removeSurface,
} from './notepad-store';
import type { ArchiveBatch, LiveNote } from './types';

/** How long a closure waits for the host to inspect a live PTY's working
 *  directory. The answer is a fallback, so it must never hold a kill up: past
 *  this the batch archives whatever the Session last reported. */
export const PROCESS_CWD_REFRESH_MS = 1000;

/**
 * Ask the host where each closing terminal Session's process actually is,
 * before its batch reads the metadata.
 *
 * A shell with no CWD escapes (no OSC 7, 9;9, 633 or 1337) never reports one,
 * so its batch would archive `cwd: null` even though the PTY is alive right now
 * and the host can inspect it — the same fallback the session-save path uses.
 * Only the Surfaces whose answer could actually be used are asked: `getCwd` is a
 * synchronous `lsof` on the PTY host's event loop, and an integration-reported
 * CWD stands (`docs/specs/notepad.md` → "Closure"). Concurrent and bounded: a
 * closure is a keystroke away from a kill, and this is metadata.
 */
async function refreshProcessCwds(surfaceIds: readonly string[]): Promise<void> {
  const platform = getPlatformOrNull();
  if (!platform) return;
  const asking = surfaceIds.filter((surfaceId) => {
    const meta = getNotepadSurfaceMeta(surfaceId);
    return !!meta && hasTerminal(meta.surfaceKind) && processCwdMayReplace(meta.cwd?.source);
  });
  const paths = await settleAllWithin(
    asking.map(async (surfaceId) => platform.getCwd(surfaceId)),
    PROCESS_CWD_REFRESH_MS,
    null,
  );
  asking.forEach((surfaceId, index) => fillTerminalProcessCwd(surfaceId, paths[index]));
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
  if (!hasNotepadArchive()) {
    for (const surfaceId of surfaceIds) removeSurface(surfaceId);
    return;
  }
  // The freeze comes before the first `getNotes`, so the batches below and the
  // notes the user can no longer touch are the same set: nothing taken during
  // the write can be archived stale or dropped by the forget step
  // (docs/specs/notepad.md → "Closure").
  const release = beginClosing(surfaceIds);
  try {
    // Read once, under the freeze, before anything awaits: these notes cannot
    // change again, and a Surface absent here is one with nothing to archive.
    const archivableNotes = new Map<string, LiveNote[]>();
    for (const surfaceId of surfaceIds) {
      const notes = getNotes(surfaceId).filter((note) => !isEmptyPlainNote(note));
      if (notes.length > 0) archivableNotes.set(surfaceId, notes);
    }
    // Before a single batch is built, so a Surface whose shell reports no CWD
    // still archives where it was.
    await refreshProcessCwds([...archivableNotes.keys()]);

    const batches: ArchiveBatch[] = [];
    /** Every archiving Surface's pending batch id — the one it appends under, or
     *  the one an earlier attempt landed that it has nothing left to re-append
     *  to. Deleting exactly these is a no-op on a first attempt and a wholesale
     *  replacement on a retry. */
    const deleteBatchIds: string[] = [];
    const archiving: string[] = [];
    // One closure, one instant: every batch this call appends closed together.
    const closedAt = Date.now();

    for (const surfaceId of surfaceIds) {
      const notes = archivableNotes.get(surfaceId);
      if (!notes) {
        // Nothing to append. A remembered id means an earlier attempt landed a
        // batch and *then* reported failure, and the user has since deleted
        // every note it held — so the stored batch goes with them rather than
        // outliving notes they were told were never archived
        // (docs/specs/notepad.md → "Closure").
        const landed = peekPendingBatchId(surfaceId);
        if (!landed) {
          // A Surface that never held a note closes without touching the archive.
          removeSurface(surfaceId);
          continue;
        }
        deleteBatchIds.push(landed);
        archiving.push(surfaceId);
        continue;
      }
      // Read again here, after the refresh above moved it, and before teardown:
      // the CWD in particular is only knowable while the Session is alive.
      const meta = getNotepadSurfaceMeta(surfaceId);
      // This Surface's remembered id, so a retry addresses the batch an earlier
      // attempt may already have landed. `closedAt` is this attempt's own: the
      // batch below is what closes, whenever that turns out to be.
      const id = pendingBatchId(surfaceId);
      deleteBatchIds.push(id);
      batches.push(buildArchiveBatch({
        id,
        closedAt,
        surfaceTitle: meta?.surfaceTitle ?? '',
        surfaceKind: meta?.surfaceKind ?? 'terminal',
        cwd: meta?.cwd ?? null,
        notes,
      }));
      archiving.push(surfaceId);
    }

    if (deleteBatchIds.length === 0) return;
    // One mutation for the whole closure, so a multi-Surface close (the
    // standalone quit gate) is a single read-modify-write that either lands
    // entirely or not at all. The edits, additions, and deletions made since a
    // write that landed and then reported failure are all in the batch that
    // survives — including the case where nothing is left to re-append and the
    // delete stands alone (docs/specs/notepad.md → "Model").
    await mutateArchive({ deleteBatchIds, append: batches });
    // Aborted means the caller gave up waiting and told the user their notes
    // were not stored — the quit was cancelled, the Surfaces are still on
    // screen, and emptying them now would delete notes in front of someone who
    // just said no. The batch is stored and its id stays remembered, so the next
    // close replaces it rather than adding a second copy.
    if (options?.signal?.aborted) return;
    for (const surfaceId of archiving) removeSurface(surfaceId);
  } finally {
    // Whether the write landed or rejected, the notepad is the user's again.
    release();
  }
}
