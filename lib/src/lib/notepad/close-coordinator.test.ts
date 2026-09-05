import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePtyAdapter, setPlatform } from '../platform';
import type { CwdState } from '../terminal-state';
import { __resetArchiveServiceForTests } from './archive-service';
import { __resetCloseCoordinatorForTests, archiveSurfaceNotes } from './close-coordinator';
import {
  addPlainNote,
  addTerminalNote,
  clearAllNotepads,
  getNotes,
  setNotepadSurfaceMetaResolver,
} from './notepad-store';
import type { NotepadArchiveV1 } from './types';

const CWD: CwdState = {
  path: '/srv/app',
  uri: 'file:///srv/app',
  host: 'build-box',
  scheme: 'file',
  pathKind: 'posix',
  isRemote: true,
  source: 'osc7',
  updatedAt: 5,
};

let adapter: FakePtyAdapter;

/** What the host actually stored, after validation. */
async function stored(): Promise<NotepadArchiveV1> {
  const loaded = await adapter.notepadArchive.load();
  return (loaded?.raw ?? { version: 1, batches: [] }) as NotepadArchiveV1;
}

beforeEach(() => {
  __resetArchiveServiceForTests();
  __resetCloseCoordinatorForTests();
  clearAllNotepads();
  adapter = new FakePtyAdapter();
  setPlatform(adapter);
});

afterEach(() => {
  __resetArchiveServiceForTests();
  __resetCloseCoordinatorForTests();
  clearAllNotepads();
});

describe('archiveSurfaceNotes', () => {
  it('touches the archive at all only when there are notes', async () => {
    const save = vi.spyOn(adapter.notepadArchive, 'save');
    await archiveSurfaceNotes(['s1']);
    expect(save).not.toHaveBeenCalled();
    expect(await stored()).toEqual({ version: 1, batches: [] });
  });

  it('archives one batch per Surface and forgets the notes', async () => {
    setNotepadSurfaceMetaResolver(() => ({ surfaceTitle: 'pnpm dev', surfaceKind: 'terminal', cwd: CWD }));
    addPlainNote('s1', 'remember this');

    await archiveSurfaceNotes(['s1']);

    const archive = await stored();
    expect(archive.batches).toHaveLength(1);
    expect(archive.batches[0]).toMatchObject({
      surfaceTitle: 'pnpm dev',
      surfaceKind: 'terminal',
      // The whole canonical CwdState is snapshotted, remote identity included.
      cwd: CWD,
      notes: [{ content: { kind: 'plain', text: 'remember this' } }],
    });
    expect(getNotes('s1')).toEqual([]);
  });

  it('falls back to empty metadata when no resolver is installed', async () => {
    addPlainNote('s1', 'orphan');
    await archiveSurfaceNotes(['s1']);
    expect((await stored()).batches[0]).toMatchObject({
      surfaceTitle: '',
      surfaceKind: 'terminal',
      cwd: null,
    });
  });

  it('never archives the runtime source link', async () => {
    addTerminalNote('s1', [{ text: 'boom', bold: true }], {
      terminalId: 's1',
      startMarker: { id: 1, line: 3, isDisposed: false, dispose: vi.fn(), onDispose: vi.fn() },
      endMarker: { id: 2, line: 4, isDisposed: false, dispose: vi.fn(), onDispose: vi.fn() },
      startColumn: 0,
      endColumn: 4,
      shape: 'linewise',
      expectedRawText: 'boom',
    } as never);

    await archiveSurfaceNotes(['s1']);

    expect(JSON.stringify(await stored())).not.toContain('Marker');
  });

  it('appends every closing Surface in one mutation', async () => {
    const save = vi.spyOn(adapter.notepadArchive, 'save');
    addPlainNote('s1', 'one');
    addPlainNote('s2', 'two');
    // No notes: removed without adding a batch, and without blocking the others.
    await archiveSurfaceNotes(['s1', 's2', 's3']);

    expect(save).toHaveBeenCalledTimes(1);
    const archive = await stored();
    expect(archive.batches.map((b) => b.notes[0].content)).toEqual([
      { kind: 'plain', text: 'one' },
      { kind: 'plain', text: 'two' },
    ]);
  });

  it('keeps the notes in place when the archive refuses the write', async () => {
    vi.spyOn(adapter.notepadArchive, 'save').mockRejectedValue(new Error('disk is full'));
    addPlainNote('s1', 'still here');

    await expect(archiveSurfaceNotes(['s1'])).rejects.toThrow('disk is full');

    expect(getNotes('s1')).toHaveLength(1);
    expect((await stored()).batches).toEqual([]);
  });

  it('reuses the batch id across a retry, so a second attempt cannot duplicate it', async () => {
    const save = vi.spyOn(adapter.notepadArchive, 'save').mockRejectedValueOnce(new Error('disk is full'));
    addPlainNote('s1', 'once');

    await expect(archiveSurfaceNotes(['s1'])).rejects.toThrow('disk is full');
    await archiveSurfaceNotes(['s1']);

    expect(save).toHaveBeenCalledTimes(2);
    const archive = await stored();
    expect(archive.batches).toHaveLength(1);
    expect(getNotes('s1')).toEqual([]);
  });

  it('mints a fresh batch id for the next closure of the same id', async () => {
    addPlainNote('s1', 'first');
    await archiveSurfaceNotes(['s1']);
    addPlainNote('s1', 'second');
    await archiveSurfaceNotes(['s1']);

    const archive = await stored();
    expect(archive.batches).toHaveLength(2);
    expect(new Set(archive.batches.map((b) => b.id)).size).toBe(2);
  });

  it('closes without an archive at all on a host that has none', async () => {
    const bare = new FakePtyAdapter();
    delete (bare as { notepadArchive?: unknown }).notepadArchive;
    setPlatform(bare);
    addPlainNote('s1', 'nowhere to put this');

    await expect(archiveSurfaceNotes(['s1'])).resolves.toBeUndefined();
    expect(getNotes('s1')).toEqual([]);
  });
});
