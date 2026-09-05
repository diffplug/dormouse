// Every user-visible permanent Surface closure passes through here first: the
// notes become one archive batch per Surface, all of them appended in a single
// mutation, and only then does the caller tear the Surface down
// (docs/specs/notepad.md → "Closure"). Separate from the store because the store
// is synchronous state and this is the one place that awaits the host.
import { hasTerminal } from 'dor/commands/types';
import { getPlatformOrNull } from '../platform';
import { fillTerminalProcessCwd } from '../terminal-state-store';
import { resolveTerminalSessionId } from '../terminal-store';
import { buildArchiveBatch } from './archive-model';
import { hasNotepadArchive, mutateArchive } from './archive-service';
import {
  beginClosing,
  getNotepadSurfaceMeta,
  getNotes,
  peekPendingBatchId,
  pendingBatchId,
  removeSurface,
} from './notepad-store';
import type { ArchiveBatch, LiveNote } from './types';

/** An untouched Add New is not a note. It would archive as a row nobody typed,
 *  and a Surface holding only those closes as if it held none. */
function isArchivable(note: LiveNote): boolean {
  return note.content.kind !== 'plain' || note.content.text !== '';
}

/** How long a closure waits for the host to inspect a live PTY's working
 *  directory. The answer is a fallback, so it must never hold a kill up: past
 *  this the batch archives whatever the Session last reported. */
export const PROCESS_CWD_REFRESH_MS = 1000;

/** The host's answer for one Session's live process CWD, or `null` if it does
 *  not arrive in time or at all. A host without a platform, a PTY that has
 *  already exited, and a host that cannot answer all read the same. */
function boundedProcessCwd(surfaceId: string): Promise<string | null> {
  const platform = getPlatformOrNull();
  if (!platform) return Promise.resolve(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), PROCESS_CWD_REFRESH_MS);
  });
  return Promise.race([
    platform.getCwd(resolveTerminalSessionId(surfaceId)).catch(() => null),
    bound,
  ]).finally(() => clearTimeout(timer));
}

/**
 * Ask the host where each closing terminal Session's process actually is,
 * before its batch reads the metadata.
 *
 * A shell with no CWD escapes (no OSC 7, 9;9, 633 or 1337) never reports one,
 * so its batch would archive `cwd: null` even though the PTY is alive right now
 * and the host can inspect it — the same fallback the session-save path uses.
 * `fillTerminalProcessCwd` refuses to override an integration-reported CWD, so
 * this can only fill a gap. Concurrent and bounded: a closure is a keystroke
 * away from a kill, and this is metadata.
 */
async function refreshProcessCwds(surfaceIds: readonly string[]): Promise<void> {
  const pending: Array<Promise<void>> = [];
  for (const surfaceId of surfaceIds) {
    if (!getNotes(surfaceId).some(isArchivable)) continue;
    const meta = getNotepadSurfaceMeta(surfaceId);
    if (!meta || !hasTerminal(meta.surfaceKind)) continue;
    pending.push(boundedProcessCwd(surfaceId).then((path) => {
      fillTerminalProcessCwd(surfaceId, path);
    }));
  }
  if (pending.length > 0) await Promise.all(pending);
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
    // Under the freeze and before a single batch is built, so a Surface whose
    // shell reports no CWD still archives where it was.
    if (archivable) await refreshProcessCwds(surfaceIds);
    const batches: ArchiveBatch[] = [];
    /** Ids of batches an earlier attempt landed whose Surface now has nothing
     *  left to re-append. Kept apart from the batches' own ids so the mutation
     *  below deletes both sets. */
    const orphanedBatchIds: string[] = [];
    const archiving: string[] = [];
    // One closure, one instant: every batch this call appends closed together.
    const closedAt = Date.now();

    for (const surfaceId of surfaceIds) {
      const notes = getNotes(surfaceId).filter(isArchivable);
      if (archivable && notes.length === 0) {
        // Nothing to append. A remembered id means an earlier attempt landed a
        // batch and *then* reported failure, and the user has since deleted
        // every note it held — so the stored batch goes with them rather than
        // outliving notes they were told were never archived
        // (docs/specs/notepad.md → "Closure").
        const landed = peekPendingBatchId(surfaceId);
        if (landed) {
          orphanedBatchIds.push(landed);
          archiving.push(surfaceId);
          continue;
        }
      }
      if (!archivable || notes.length === 0) {
        // A Surface that never held a note closes without touching the archive.
        removeSurface(surfaceId);
        continue;
      }
      // The metadata is snapshotted here, before teardown: the CWD in particular
      // is only knowable while the Session is alive.
      const meta = getNotepadSurfaceMeta(surfaceId);
      batches.push(buildArchiveBatch({
        // This Surface's remembered id, so a retry addresses the batch an
        // earlier attempt may already have landed. `closedAt` is this attempt's
        // own: the batch below is what closes, whenever that turns out to be.
        id: pendingBatchId(surfaceId),
        closedAt,
        surfaceTitle: meta?.surfaceTitle ?? '',
        surfaceKind: meta?.surfaceKind ?? 'terminal',
        cwd: meta?.cwd ?? null,
        notes,
      }));
      archiving.push(surfaceId);
    }

    if (batches.length === 0 && orphanedBatchIds.length === 0) return;
    // One mutation for the whole closure, so a multi-Surface close (the
    // standalone quit gate) is a single read-modify-write that either lands
    // entirely or not at all. Deleting exactly the ids being appended is a
    // no-op on a first attempt and a wholesale replacement on a retry, so the
    // edits, additions, and deletions made since a write that landed and then
    // reported failure are all in the batch that survives — including the case
    // where nothing is left to re-append and the delete stands alone
    // (docs/specs/notepad.md → "Model").
    await mutateArchive({
      deleteBatchIds: [...orphanedBatchIds, ...batches.map((batch) => batch.id)],
      append: batches,
    });
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
