// Every user-visible permanent Surface closure passes through here first: the
// notes become one archive batch per Surface, all of them appended in a single
// mutation, and only then does the caller tear the Surface down
// (docs/specs/notepad.md → "Closure"). Separate from the store because the store
// is synchronous state and this is the one place that awaits the host.
import { buildArchiveBatch } from './archive-model';
import { hasNotepadArchive, mutateArchive } from './archive-service';
import { getNotepadSurfaceMeta, getNotes, newNotepadId, removeSurface } from './notepad-store';
import type { ArchiveBatch } from './types';

/**
 * The identity of a closure attempt, minted on the first try and reused by every
 * retry until one succeeds. That reuse is what makes a retried append
 * idempotent: `applyArchiveMutation` skips a batch id already present, so a
 * "Close anyway" after a save that actually landed cannot duplicate it, and a
 * second attempt after a genuine failure appends exactly one batch.
 */
const attempts = new Map<string, { batchId: string; closedAt: number }>();

/**
 * Archive the notes of every Surface in `surfaceIds` and forget them.
 *
 * Resolves once the notes are safely stored (or there were none). Rejects with
 * the archive service's user-presentable error when the write fails, leaving
 * every note in place so the caller can offer Keep open / Close anyway rather
 * than dropping them.
 */
export async function archiveSurfaceNotes(surfaceIds: readonly string[]): Promise<void> {
  // No archive port means no notepad on this host at all, so there is nothing
  // captured to lose and nowhere to write it — closure must not be blockable.
  const archivable = hasNotepadArchive();
  const batches: ArchiveBatch[] = [];
  const archiving: string[] = [];

  for (const surfaceId of surfaceIds) {
    const notes = getNotes(surfaceId);
    if (!archivable || notes.length === 0) {
      // A Surface that never held a note closes without touching the archive.
      removeSurface(surfaceId);
      continue;
    }
    let attempt = attempts.get(surfaceId);
    if (!attempt) {
      attempt = { batchId: newNotepadId('batch'), closedAt: Date.now() };
      attempts.set(surfaceId, attempt);
    }
    // The metadata is snapshotted here, before teardown: the CWD in particular
    // is only knowable while the Session is alive.
    const meta = getNotepadSurfaceMeta(surfaceId);
    batches.push(buildArchiveBatch({
      id: attempt.batchId,
      closedAt: attempt.closedAt,
      surfaceTitle: meta?.surfaceTitle ?? '',
      surfaceKind: meta?.surfaceKind ?? 'terminal',
      cwd: meta?.cwd ?? null,
      notes,
    }));
    archiving.push(surfaceId);
  }

  if (batches.length === 0) return;
  // One mutation for the whole closure, so a multi-Surface close (the standalone
  // quit gate) is a single read-modify-write that either lands entirely or not
  // at all.
  await mutateArchive({ append: batches });
  for (const surfaceId of archiving) {
    removeSurface(surfaceId);
    attempts.delete(surfaceId);
  }
}

/** Test-only helper. Do not use in application code. */
export function __resetCloseCoordinatorForTests(): void {
  attempts.clear();
}
