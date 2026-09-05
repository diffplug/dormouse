/**
 * The VS Code half of the notepad archive (`docs/specs/notepad.md`).
 *
 * The webview owns the archive's *shape* — it validates, mutates, and retries;
 * this side only stores bytes and names the version they were read at, so two
 * webviews appending at once cannot lose each other's batches. The host-side
 * mutations at the bottom exist for the one case the webview cannot cover: a
 * teardown where the webview is already gone (an editor panel closing, the
 * extension deactivating) and nobody is left to run its close coordinator.
 */
import type * as vscode from 'vscode';
import { randomUUID } from 'crypto';

import { withArchiveFile, type ArchiveStorage } from './notepad-archive-file';
import {
  applyArchiveMutation,
  batchFromVolatile,
  EMPTY_ARCHIVE,
  isEmptyMutation,
  readNotepadArchive,
} from '../../lib/src/lib/notepad/archive-model';
import type {
  ArchiveBatch,
  NotepadArchiveLoadResult,
  NotepadArchiveMutation,
  VolatileNotepadSnapshot,
} from '../../lib/src/lib/notepad/types';

/** Legacy machine-local key, imported once and never registered for Settings Sync. */
export const NOTEPAD_ARCHIVE_KEY = 'dormouse.notepadArchive.v1';

function transaction<T>(context: vscode.ExtensionContext, operation: (storage: ArchiveStorage) => Promise<T>): Promise<T> {
  return withArchiveFile(context.globalStorageUri.fsPath, () => readStored(context), operation);
}

/**
 * What is stored, as the JSON text the shared validator reads.
 *
 * A stored value that is not a string is re-serialized rather than ignored: it
 * is still *something*, and reporting the key as empty would let the next save
 * overwrite it. The archive is never silently replaced — the shared layer shows
 * it as unreadable and offers the user one recovery.
 */
function readStored(context: vscode.ExtensionContext): string | undefined {
  const stored = context.globalState.get(NOTEPAD_ARCHIVE_KEY);
  if (stored === undefined) return undefined;
  if (typeof stored === 'string') return stored;
  const text = JSON.stringify(stored);
  // `null` parses cleanly and fails validation, which is exactly the "present
  // but unreadable" outcome we want for a value we cannot even serialize.
  return typeof text === 'string' ? text : 'null';
}

/** The stored archive and the token naming it, or `null` if nothing was ever archived. */
export function loadNotepadArchive(
  context: vscode.ExtensionContext,
): Promise<NotepadArchiveLoadResult | null> {
  return transaction(context, async ({ raw, revision }) => {
    return raw === undefined ? null : { raw, revision: revision! };
  });
}

/** Replace the stored archive iff it is still at `baseRevision` (`null` = nothing stored). */
export function saveNotepadArchive(
  context: vscode.ExtensionContext,
  json: string,
  baseRevision: string | null,
): Promise<'ok' | 'conflict'> {
  return transaction(context, async (storage) => {
    if (baseRevision !== storage.revision) return 'conflict';
    await storage.write(json);
    return 'ok';
  });
}

/**
 * User-initiated recovery from an unreadable archive: copy the value to a
 * quarantine file and clear the main one, so the next `load` returns `null` and
 * appends work again.
 *
 * Moved aside, **never deleted**: the user asked for a working archive, not for
 * their notes to be destroyed, and only a human can tell whether what is in
 * there is recoverable (`docs/specs/notepad.md` → Archive).
 */
export function resetUnreadableNotepadArchive(context: vscode.ExtensionContext): Promise<void> {
  return transaction(context, async (storage) => {
    // A recovery button can outlive another webview's successful recovery.
    if (storage.raw === undefined || readNotepadArchive(storage.raw)) return;
    await storage.reset();
  });
}

/**
 * Archive one drained volatile mirror: the batches its Surfaces would have
 * written had they closed normally, and the deletions its Archive view had
 * staged, as **one** mutation, so a teardown lands whole or not at all, exactly
 * like a closure.
 * Reports failure; whether that is fatal is the caller's call, and for both
 * callers it is not — VS Code destroys the container whatever we say.
 */
export function archiveVolatileMirror(
  context: vscode.ExtensionContext,
  mirror: VolatileNotepadSnapshot,
): Promise<void> {
  const closedAt = Date.now();
  const append: ArchiveBatch[] = [];
  for (const surface of mirror.surfaces) {
    // A fresh id per teardown. Idempotence is by batch id, so this is the one
    // place a repeat would duplicate — and a mirror is drained, not retried.
    const batch = batchFromVolatile(surface, randomUUID(), closedAt);
    if (batch) append.push(batch);
  }
  return mutateNotepadArchive(context, { append, ...mirror.stagedDeletions });
}

/** Read-modify-write under the same transaction lock the webview's saves go through.
 *  Idempotent by batch and note id; nothing to write touches nothing. */
export function mutateNotepadArchive(
  context: vscode.ExtensionContext,
  mutation: NotepadArchiveMutation,
): Promise<void> {
  if (isEmptyMutation(mutation)) return Promise.resolve();
  return transaction(context, async (storage) => {
    const raw = storage.raw;
    const archive = raw === undefined ? EMPTY_ARCHIVE : readNotepadArchive(raw);
    if (!archive) {
      // Every append fails until the user recovers it. Replacing it here would
      // destroy whatever is in there without anyone being asked
      // (`docs/specs/notepad.md` → Archive).
      throw new Error('the notepad archive is unreadable; recovery is user-initiated');
    }
    await storage.write(JSON.stringify(applyArchiveMutation(archive, mutation)));
  });
}
