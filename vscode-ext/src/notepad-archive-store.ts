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

import { createSerialQueue } from '../../lib/src/host/remote/serial-queue';
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

/**
 * The one `globalState` key the archive lives under.
 *
 * `globalState` is workspace-independent, which is what the archive wants: a
 * Surface closed in one window belongs to the same machine-local archive as
 * every other. **This key is never handed to `context.globalState.setKeysForSync`**
 * — Settings Sync would carry captured terminal excerpts, their CWDs, and their
 * Surface titles to every machine the user signs into, and the archive is
 * deliberately machine-local (`docs/specs/notepad.md`). VS Code syncs only what
 * an extension registers, so the rule is kept by there being no such call
 * anywhere in this extension; adding one for anything else must not add this key.
 */
export const NOTEPAD_ARCHIVE_KEY = 'dormouse.notepadArchive.v1';

/**
 * Names the stored version for the compare-and-swap in `NotepadArchivePort`.
 *
 * A counter rather than a hash of the bytes: the only question a saver asks is
 * "has anyone written since I read?", and this extension host is the only writer
 * of the key. It is per extension-host lifetime, which is enough because a
 * revision is only ever compared against one this same process handed out — a
 * webview that boots into a new host loads before it saves.
 */
let revision = 0;

/**
 * One queue for every read-modify-write, so two webviews — or a webview and a
 * teardown — cannot interleave a read with someone else's write. `globalState`
 * reads are synchronous but its writes are not, and the next reader must not see
 * the value from before an `update` that has not landed.
 */
const serialized = createSerialQueue();

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

/** `null` when nothing is stored — the `baseRevision` a first save must pass. */
function currentRevision(context: vscode.ExtensionContext): string | null {
  return readStored(context) === undefined ? null : `r${revision}`;
}

async function writeArchive(context: vscode.ExtensionContext, json: string): Promise<void> {
  await context.globalState.update(NOTEPAD_ARCHIVE_KEY, json);
  revision += 1;
}

/** The stored archive and the token naming it, or `null` if nothing was ever archived. */
export function loadNotepadArchive(
  context: vscode.ExtensionContext,
): Promise<NotepadArchiveLoadResult | null> {
  return serialized(async () => {
    const raw = readStored(context);
    return raw === undefined ? null : { raw, revision: `r${revision}` };
  });
}

/** Replace the stored archive iff it is still at `baseRevision` (`null` = nothing stored). */
export function saveNotepadArchive(
  context: vscode.ExtensionContext,
  json: string,
  baseRevision: string | null,
): Promise<'ok' | 'conflict'> {
  return serialized(async () => {
    if (baseRevision !== currentRevision(context)) return 'conflict';
    await writeArchive(context, json);
    return 'ok';
  });
}

/**
 * User-initiated recovery from an unreadable archive: copy the value to a
 * sibling key and clear the main one, so the next `load` returns `null` and
 * appends work again.
 *
 * Moved aside, **never deleted**: the user asked for a working archive, not for
 * their notes to be destroyed, and only a human can tell whether what is in
 * there is recoverable (`docs/specs/notepad.md` → Archive).
 */
export function resetUnreadableNotepadArchive(context: vscode.ExtensionContext): Promise<void> {
  return serialized(async () => {
    // A recovery button can outlive another webview's successful recovery.
    // Revalidate under the mutation lock before moving any bytes aside.
    const raw = readStored(context);
    if (raw === undefined || readNotepadArchive(raw)) return;
    const stored = context.globalState.get(NOTEPAD_ARCHIVE_KEY);
    if (stored !== undefined) {
      await context.globalState.update(`${NOTEPAD_ARCHIVE_KEY}.unreadable-${Date.now()}`, stored);
    }
    await context.globalState.update(NOTEPAD_ARCHIVE_KEY, undefined);
    revision += 1;
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

/** Read-modify-write under the same queue the webview's saves go through.
 *  Idempotent by batch and note id; nothing to write touches nothing. */
export function mutateNotepadArchive(
  context: vscode.ExtensionContext,
  mutation: NotepadArchiveMutation,
): Promise<void> {
  if (isEmptyMutation(mutation)) return Promise.resolve();
  return serialized(async () => {
    const raw = readStored(context);
    const archive = raw === undefined ? EMPTY_ARCHIVE : readNotepadArchive(raw);
    if (!archive) {
      // Every append fails until the user recovers it. Replacing it here would
      // destroy whatever is in there without anyone being asked
      // (`docs/specs/notepad.md` → Archive).
      throw new Error('the notepad archive is unreadable; recovery is user-initiated');
    }
    await writeArchive(context, JSON.stringify(applyArchiveMutation(archive, mutation)));
  });
}
