/**
 * The archive as the extension host stores it (`docs/specs/notepad.md`).
 *
 * What is worth pinning here is not the JSON — that is `archive-model`'s — but
 * the two things only this side can get wrong: the compare-and-swap that keeps
 * two webviews from clobbering each other, and the queue that keeps a read from
 * landing between someone else's read and write.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { ArchiveBatch, NotepadArchiveV1 } from '../../lib/src/lib/notepad/types';
import {
  appendNotepadBatches,
  archiveVolatileMirror,
  commitStagedDeletions,
  loadNotepadArchive,
  NOTEPAD_ARCHIVE_KEY,
  resetUnreadableNotepadArchive,
  saveNotepadArchive,
} from '../src/notepad-archive-store';

/**
 * A `globalState` whose writes land a microtask late, like the real one's do.
 * That delay is the whole reason the store has a queue: a second reader that
 * gets in before an `update` settles would build its mutation on the value from
 * before it.
 */
function fakeContext() {
  const store = new Map<string, unknown>();
  const globalState = {
    get: (key: string) => store.get(key),
    update: async (key: string, value: unknown) => {
      await Promise.resolve();
      if (value === undefined) store.delete(key);
      else store.set(key, value);
    },
    keys: () => [...store.keys()],
  };
  return { context: { globalState } as never, store };
}

function batch(id: string, noteIds: string[]): ArchiveBatch {
  return {
    id,
    closedAt: 1_700_000_000_000,
    surfaceTitle: `surface ${id}`,
    surfaceKind: 'terminal',
    cwd: null,
    notes: noteIds.map((noteId) => ({
      id: noteId,
      createdAt: 1_700_000_000_001,
      content: { kind: 'plain', text: `note ${noteId}` },
    })),
  };
}

function stored(store: Map<string, unknown>): NotepadArchiveV1 {
  return JSON.parse(store.get(NOTEPAD_ARCHIVE_KEY) as string) as NotepadArchiveV1;
}

const archiveOf = (...batches: ArchiveBatch[]): NotepadArchiveV1 => ({ version: 1, batches });

describe('the notepad archive in globalState', () => {
  it('reports nothing archived, then round-trips what a webview saved', async () => {
    const { context, store } = fakeContext();
    expect(await loadNotepadArchive(context)).toBeNull();

    // `null` is the base revision for "nothing stored" — the only one a first
    // save may pass.
    expect(await saveNotepadArchive(context, JSON.stringify(archiveOf(batch('b1', ['n1']))), null)).toBe('ok');

    const loaded = await loadNotepadArchive(context);
    expect(JSON.parse(loaded!.raw)).toEqual(archiveOf(batch('b1', ['n1'])));
    expect(stored(store).batches).toHaveLength(1);
  });

  it('refuses a save built on a revision someone else has moved', async () => {
    const { context, store } = fakeContext();
    // Two webviews load the same archive; the first one to save wins, and the
    // second is told to re-read rather than allowed to drop the first's batch.
    await saveNotepadArchive(context, JSON.stringify(archiveOf(batch('b1', ['n1']))), null);
    const first = await loadNotepadArchive(context);
    const second = await loadNotepadArchive(context);
    expect(second!.revision).toBe(first!.revision);

    expect(await saveNotepadArchive(context, JSON.stringify(archiveOf(batch('b2', ['n2']))), first!.revision))
      .toBe('ok');
    expect(await saveNotepadArchive(context, JSON.stringify(archiveOf(batch('b3', ['n3']))), second!.revision))
      .toBe('conflict');

    expect(stored(store).batches.map((b) => b.id)).toEqual(['b2']);
    // The conflicted webview re-reads and now has a revision that works.
    const retry = await loadNotepadArchive(context);
    expect(await saveNotepadArchive(context, JSON.stringify(archiveOf(batch('b3', ['n3']))), retry!.revision))
      .toBe('ok');
  });

  it('moves an unreadable archive aside instead of deleting it', async () => {
    const { context, store } = fakeContext();
    await context.globalState.update(NOTEPAD_ARCHIVE_KEY, '{ this is not json');

    await resetUnreadableNotepadArchive(context);

    // The main key is empty, so appends work again...
    expect(await loadNotepadArchive(context)).toBeNull();
    // ...and the user's data is still on disk under a sibling key, because only
    // a human can tell whether it is recoverable.
    const rescued = [...store.keys()].filter((key) => key.startsWith(`${NOTEPAD_ARCHIVE_KEY}.unreadable-`));
    expect(rescued).toHaveLength(1);
    expect(store.get(rescued[0])).toBe('{ this is not json');
  });

  it('appends idempotently by batch id', async () => {
    const { context, store } = fakeContext();
    // A teardown that retries — or two paths that both archive the same closure
    // — must not double the batch. The id is minted once, which is what makes
    // the repeat a no-op.
    await appendNotepadBatches(context, [batch('b1', ['n1'])]);
    await appendNotepadBatches(context, [batch('b1', ['n1']), batch('b2', ['n2'])]);

    expect(stored(store).batches.map((b) => b.id)).toEqual(['b1', 'b2']);
  });

  it('never drops an append that raced another one', async () => {
    const { context, store } = fakeContext();
    // Both start before either has written. Without the queue the second would
    // read the pre-write archive and save a copy of it with only its own batch.
    await Promise.all([
      appendNotepadBatches(context, [batch('b1', ['n1'])]),
      appendNotepadBatches(context, [batch('b2', ['n2'])]),
    ]);

    expect(stored(store).batches.map((b) => b.id).sort()).toEqual(['b1', 'b2']);
  });

  it('refuses to append onto an unreadable archive', async () => {
    const { context, store } = fakeContext();
    await context.globalState.update(NOTEPAD_ARCHIVE_KEY, JSON.stringify({ version: 99 }));

    await expect(appendNotepadBatches(context, [batch('b1', ['n1'])])).rejects.toThrow(/unreadable/);
    // Whatever is in there is still in there: replacing it is the user's call.
    expect(store.get(NOTEPAD_ARCHIVE_KEY)).toBe(JSON.stringify({ version: 99 }));
  });

  it('commits staged deletions and drops a batch they empty', async () => {
    const { context, store } = fakeContext();
    await appendNotepadBatches(context, [batch('b1', ['n1', 'n2']), batch('b2', ['n3'])]);

    await commitStagedDeletions(context, {
      deleteBatchIds: [],
      deleteNotes: [{ batchId: 'b1', noteId: 'n1' }, { batchId: 'b2', noteId: 'n3' }],
    });

    const batches = stored(store).batches;
    expect(batches.map((b) => b.id)).toEqual(['b1']);
    expect(batches[0].notes.map((n) => n.id)).toEqual(['n2']);
  });

  it('archives a drained mirror as one batch per Surface that had notes', async () => {
    const { context, store } = fakeContext();
    await appendNotepadBatches(context, [batch('old', ['n0'])]);

    await archiveVolatileMirror(context, {
      surfaces: [
        {
          surfaceId: 'pane-1',
          surfaceTitle: 'zsh',
          surfaceKind: 'terminal',
          cwd: {
            path: '/repo', pathKind: 'posix', isRemote: false, source: 'osc7', updatedAt: 5,
          },
          notes: [{ id: 'n1', createdAt: 3, content: { kind: 'plain', text: 'hi' } }],
        },
        // No notes, so nothing to archive — not an empty batch.
        { surfaceId: 'pane-2', surfaceTitle: 'bash', surfaceKind: 'terminal', cwd: null, notes: [] },
      ],
      stagedDeletions: { deleteBatchIds: ['old'], deleteNotes: [] },
    });

    const batches = stored(store).batches;
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      surfaceTitle: 'zsh',
      surfaceKind: 'terminal',
      cwd: { path: '/repo' },
      notes: [{ id: 'n1' }],
    });
    // The mirror's staged deletions are committed too, so an Archive view whose
    // webview was destroyed still gets its deletions.
    expect(batches.map((b) => b.id)).not.toContain('old');
  });
});

/**
 * The one rule about this key that no unit test can reach through the API: the
 * archive is machine-local, and Settings Sync would carry captured terminal
 * excerpts to every machine the user signs into (`docs/specs/notepad.md`). VS
 * Code syncs only what an extension registers, so the check is that this
 * extension registers nothing.
 */
it('never opts any key into Settings Sync', () => {
  const dir = fileURLToPath(new URL('../src/', import.meta.url));
  const offenders = readdirSync(dir)
    .filter((name) => name.endsWith('.ts') || name.endsWith('.js'))
    // A call, not a mention — the rule is stated in a comment on the key itself.
    .filter((name) => /setKeysForSync\s*\(/.test(readFileSync(join(dir, name), 'utf8')));
  expect(offenders).toEqual([]);
});
