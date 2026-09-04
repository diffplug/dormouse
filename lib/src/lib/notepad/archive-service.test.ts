import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePtyAdapter, setPlatform } from '../platform';
import type { PlatformAdapter } from '../platform/types';
import { applyArchiveMutation } from './archive-model';
import {
  ARCHIVE_ABSENT_MESSAGE,
  ARCHIVE_UNREADABLE_MESSAGE,
  __resetArchiveServiceForTests,
  ensureArchiveLoaded,
  getArchiveSnapshot,
  hasNotepadArchive,
  mutateArchive,
  refreshArchive,
  resetUnreadableArchive,
  subscribeToArchive,
} from './archive-service';
import { createMemoryNotepadArchivePort, type MemoryNotepadArchivePort } from './memory-archive-port';
import type { ArchiveBatch, NotepadArchivePort, NotepadArchiveV1 } from './types';

function batch(id: string, noteText = id): ArchiveBatch {
  return {
    id,
    closedAt: 1_700_000_000_000,
    surfaceTitle: `pane ${id}`,
    surfaceKind: 'terminal',
    cwd: null,
    notes: [{ id: `${id}-n1`, createdAt: 1, content: { kind: 'plain', text: noteText } }],
  };
}

/** A platform that is nothing but its archive port — the service reads no other
 *  adapter surface. */
function installPort(port: NotepadArchivePort | undefined): void {
  setPlatform({ notepadArchive: port } as unknown as PlatformAdapter);
}

let port: MemoryNotepadArchivePort;

beforeEach(() => {
  __resetArchiveServiceForTests();
  port = createMemoryNotepadArchivePort();
  installPort(port);
});

afterEach(() => {
  __resetArchiveServiceForTests();
});

describe('loading', () => {
  it('reports an empty archive as ready when nothing was ever archived', async () => {
    await ensureArchiveLoaded();
    expect(getArchiveSnapshot()).toEqual({ status: 'ready', archive: { version: 1, batches: [] } });
  });

  it('loads what the host stored and notifies subscribers', async () => {
    port.seed({ version: 1, batches: [batch('b1')] });
    const listener = vi.fn();
    subscribeToArchive(listener);
    await ensureArchiveLoaded();
    expect(getArchiveSnapshot().status).toBe('ready');
    expect(getArchiveSnapshot().archive.batches.map((b) => b.id)).toEqual(['b1']);
    expect(listener).toHaveBeenCalled();
  });

  it('is idempotent: a second call joins the first load rather than re-reading', async () => {
    const load = vi.spyOn(port, 'load');
    await Promise.all([ensureArchiveLoaded(), ensureArchiveLoaded()]);
    await ensureArchiveLoaded();
    expect(load).toHaveBeenCalledTimes(1);
    await refreshArchive();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('is absent when the host has no archive port', async () => {
    installPort(undefined);
    expect(hasNotepadArchive()).toBe(false);
    await ensureArchiveLoaded();
    expect(getArchiveSnapshot().status).toBe('absent');
    await expect(mutateArchive({ append: [batch('b1')] })).rejects.toThrow(ARCHIVE_ABSENT_MESSAGE);
  });

  it('reports a read failure as a transient error', async () => {
    vi.spyOn(port, 'load').mockRejectedValueOnce(new Error('disk on fire'));
    await ensureArchiveLoaded();
    expect(getArchiveSnapshot().status).toBe('error');
    expect(getArchiveSnapshot().error).toBe('disk on fire');
  });
});

describe('unreadable data', () => {
  it('reports it and never replaces it', async () => {
    port.corrupt({ version: 99, batches: 'nope' });
    await ensureArchiveLoaded();
    expect(getArchiveSnapshot().status).toBe('unreadable');
    expect(getArchiveSnapshot().error).toBe(ARCHIVE_UNREADABLE_MESSAGE);
    expect(getArchiveSnapshot().archive.batches).toEqual([]);

    await expect(mutateArchive({ append: [batch('b1')] })).rejects.toThrow(ARCHIVE_UNREADABLE_MESSAGE);
    // The failed append must not have written over it.
    expect((await port.load())?.raw).toEqual({ version: 99, batches: 'nope' });
    expect(getArchiveSnapshot().status).toBe('unreadable');
  });

  it('recovers only on the user-initiated reset, keeping the old data aside', async () => {
    port.corrupt('{ not json');
    await ensureArchiveLoaded();
    expect(getArchiveSnapshot().status).toBe('unreadable');

    await resetUnreadableArchive();
    expect(getArchiveSnapshot().status).toBe('ready');
    expect(getArchiveSnapshot().archive.batches).toEqual([]);
    expect(port.unreadableCopies()).toEqual(['{ not json']);

    await mutateArchive({ append: [batch('b1')] });
    expect(getArchiveSnapshot().archive.batches.map((b) => b.id)).toEqual(['b1']);
  });
});

describe('mutating', () => {
  it('appends and deletes through the host store', async () => {
    await mutateArchive({ append: [batch('b1'), batch('b2')] });
    expect(getArchiveSnapshot().archive.batches.map((b) => b.id)).toEqual(['b1', 'b2']);
    expect(getArchiveSnapshot().status).toBe('ready');

    await mutateArchive({ deleteBatchIds: ['b1'] });
    expect(getArchiveSnapshot().archive.batches.map((b) => b.id)).toEqual(['b2']);

    await mutateArchive({ deleteNotes: [{ batchId: 'b2', noteId: 'b2-n1' }] });
    expect(getArchiveSnapshot().archive.batches).toEqual([]);
    expect((await port.load())?.raw).toEqual({ version: 1, batches: [] });
  });

  it('touches the host not at all for an empty mutation', async () => {
    const load = vi.spyOn(port, 'load');
    const save = vi.spyOn(port, 'save');
    await mutateArchive({});
    await mutateArchive({ append: [], deleteBatchIds: [] });
    expect(load).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('serializes concurrent mutations so both land without a conflict', async () => {
    let conflicts = 0;
    const save = port.save.bind(port);
    vi.spyOn(port, 'save').mockImplementation(async (archive, base) => {
      const outcome = await save(archive, base);
      if (outcome === 'conflict') conflicts += 1;
      return outcome;
    });

    await Promise.all([
      mutateArchive({ append: [batch('b1')] }),
      mutateArchive({ append: [batch('b2')] }),
    ]);

    expect(getArchiveSnapshot().archive.batches.map((b) => b.id)).toEqual(['b1', 'b2']);
    expect(conflicts).toBe(0);
  });

  it('reloads and reapplies when someone else wrote first, landing both batches', async () => {
    const stolen = batch('outsider');
    let firstSave = true;
    const real = port.save.bind(port);
    vi.spyOn(port, 'save').mockImplementation(async (archive, base) => {
      if (!firstSave) return real(archive, base);
      firstSave = false;
      // Another writer (a second Window, the extension host) got there between
      // our load and our save.
      const loaded = await port.load();
      const current = (loaded?.raw as NotepadArchiveV1 | undefined) ?? { version: 1, batches: [] };
      await real(applyArchiveMutation(current, { append: [stolen] }), loaded?.revision ?? null);
      return 'conflict';
    });

    await mutateArchive({ append: [batch('mine')] });

    expect(getArchiveSnapshot().archive.batches.map((b) => b.id)).toEqual(['outsider', 'mine']);
    expect(getArchiveSnapshot().status).toBe('ready');
  });

  it('gives up after a bounded number of conflicts', async () => {
    vi.spyOn(port, 'save').mockResolvedValue('conflict');
    await expect(mutateArchive({ append: [batch('b1')] })).rejects.toThrow(/kept changing/);
    expect(getArchiveSnapshot().status).toBe('error');
    expect(port.save).toHaveBeenCalledTimes(5);
  });

  it('surfaces a save failure and leaves the archive unchanged', async () => {
    await mutateArchive({ append: [batch('b1')] });
    const before = getArchiveSnapshot().archive;

    vi.spyOn(port, 'save').mockRejectedValueOnce(new Error('read-only volume'));
    await expect(mutateArchive({ append: [batch('b2')] })).rejects.toThrow('read-only volume');

    expect(getArchiveSnapshot().status).toBe('error');
    expect(getArchiveSnapshot().error).toBe('read-only volume');
    expect(getArchiveSnapshot().archive).toBe(before);
    expect((await port.load())?.raw).toEqual({ version: 1, batches: [batch('b1')] });

    // The queue survives one caller's failure.
    await mutateArchive({ append: [batch('b3')] });
    expect(getArchiveSnapshot().archive.batches.map((b) => b.id)).toEqual(['b1', 'b3']);
  });

  it('is idempotent by batch id across retries of the same closure', async () => {
    await mutateArchive({ append: [batch('b1')] });
    await mutateArchive({ append: [batch('b1')] });
    expect(getArchiveSnapshot().archive.batches).toHaveLength(1);
  });
});

describe('through FakePtyAdapter', () => {
  it('uses the adapter own in-memory port, including its seed and corrupt seams', async () => {
    const adapter = new FakePtyAdapter();
    setPlatform(adapter);
    adapter.seedNotepadArchive({ version: 1, batches: [batch('seeded')] });
    await ensureArchiveLoaded();
    expect(getArchiveSnapshot().archive.batches.map((b) => b.id)).toEqual(['seeded']);

    await mutateArchive({ append: [batch('closed')] });
    expect(adapter.notepadArchive.lastVolatileSnapshot()).toBeNull();
    expect(getArchiveSnapshot().archive.batches.map((b) => b.id)).toEqual(['seeded', 'closed']);

    adapter.corruptNotepadArchive();
    await refreshArchive();
    expect(getArchiveSnapshot().status).toBe('unreadable');
  });
});
