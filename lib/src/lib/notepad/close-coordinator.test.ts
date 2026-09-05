import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePtyAdapter, setPlatform } from '../platform';
import type { CwdState } from '../terminal-state';
import { __resetArchiveServiceForTests } from './archive-service';
import { archiveSurfaceNotes } from './close-coordinator';
import {
  addPlainNote,
  addTerminalNote,
  clearAllNotepads,
  deleteNote,
  getNotes,
  isSurfaceClosing,
  setNotepadSurfaceMetaResolver,
  setNoteText,
} from './notepad-store';
import type { NotepadArchiveV1, RuntimeTerminalSource } from './types';

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

function marker(): { dispose: ReturnType<typeof vi.fn> } {
  return { id: 1, line: 3, isDisposed: false, dispose: vi.fn(), onDispose: vi.fn() } as never;
}

function source(terminalId = 's1'): RuntimeTerminalSource & {
  startMarker: { dispose: ReturnType<typeof vi.fn> };
  endMarker: { dispose: ReturnType<typeof vi.fn> };
} {
  return {
    terminalId,
    startMarker: marker(),
    endMarker: marker(),
    startColumn: 0,
    endColumn: 4,
    shape: 'linewise',
    expectedRawText: 'boom',
  } as never;
}

/** A `save` parked until `release`, so a test can act on the store while a
 *  closure is mid-write. `entered` settles once the coordinator is inside it. */
function heldSave(): { entered: Promise<void>; release: () => void } {
  const real = adapter.notepadArchive.save.bind(adapter.notepadArchive);
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  vi.spyOn(adapter.notepadArchive, 'save').mockImplementation(async (archive, base) => {
    markEntered();
    await gate;
    return real(archive, base);
  });
  return { entered, release: () => open() };
}

beforeEach(() => {
  __resetArchiveServiceForTests();
  clearAllNotepads();
  adapter = new FakePtyAdapter();
  setPlatform(adapter);
});

afterEach(() => {
  __resetArchiveServiceForTests();
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

  it('retries a genuinely failed write without duplicating anything', async () => {
    const save = vi.spyOn(adapter.notepadArchive, 'save').mockRejectedValueOnce(new Error('disk is full'));
    addPlainNote('s1', 'once');

    await expect(archiveSurfaceNotes(['s1'])).rejects.toThrow('disk is full');
    await archiveSurfaceNotes(['s1']);

    expect(save).toHaveBeenCalledTimes(2);
    const archive = await stored();
    expect(archive.batches).toHaveLength(1);
    expect(getNotes('s1')).toEqual([]);
  });

  it('keeps the notes added after a write that landed but reported failure', async () => {
    // The VS Code adapter's request timeout produces exactly this: the host
    // stored the batch, the webview was told it did not. A batch id remembered
    // across the rejection would make the second attempt a no-op append, and
    // `removeSurface` would then throw away everything typed in between.
    const real = adapter.notepadArchive.save.bind(adapter.notepadArchive);
    vi.spyOn(adapter.notepadArchive, 'save').mockImplementationOnce(async (archive, base) => {
      await real(archive, base);
      throw new Error('the request timed out');
    });
    addPlainNote('s1', 'first');

    await expect(archiveSurfaceNotes(['s1'])).rejects.toThrow('the request timed out');
    // The Surface stayed open, so the user kept typing into it.
    addPlainNote('s1', 'second');
    await archiveSurfaceNotes(['s1']);

    const texts = (await stored()).batches.flatMap((b) => b.notes.map((n) => (
      n.content.kind === 'plain' ? n.content.text : ''
    )));
    expect(texts).toEqual(['first', 'second']);
    expect(getNotes('s1')).toEqual([]);
  });

  it('stamps each closure attempt with a fresh closedAt', async () => {
    vi.spyOn(adapter.notepadArchive, 'save').mockRejectedValueOnce(new Error('disk is full'));
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      addPlainNote('s1', 'once');
      await expect(archiveSurfaceNotes(['s1'])).rejects.toThrow('disk is full');
      nowSpy.mockReturnValue(9_000);
      await archiveSurfaceNotes(['s1']);
    } finally {
      nowSpy.mockRestore();
    }

    expect((await stored()).batches[0].closedAt).toBe(9_000);
  });

  it('leaves the live notes alone when the caller has already given up', async () => {
    // The standalone quit gate's deadline fired and the user chose Cancel: the
    // batch is stored, but emptying the notepads now would delete notes in front
    // of someone who just said no.
    const controller = new AbortController();
    const realSave = adapter.notepadArchive.save.bind(adapter.notepadArchive);
    vi.spyOn(adapter.notepadArchive, 'save').mockImplementation(async (archive, base) => {
      controller.abort(); // the deadline fires while the write is in flight
      return realSave(archive, base);
    });
    addPlainNote('s1', 'still mine');

    await archiveSurfaceNotes(['s1'], { signal: controller.signal });

    // Stored — and still on screen, so a later close re-archives it (once).
    expect((await stored()).batches).toHaveLength(1);
    expect(getNotes('s1')).toHaveLength(1);
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

  it('freezes the notepad from the snapshot until the write settles', async () => {
    const held = heldSave();
    const first = addPlainNote('s1', 'snapshotted')!;
    const closing = archiveSurfaceNotes(['s1']);
    await held.entered;

    // Everything that would change what is being written is refused. An edit is
    // the worst of them: the batch already holds the pre-edit text, and the
    // forget step below would then take the edit with it.
    expect(isSurfaceClosing('s1')).toBe(true);
    setNoteText('s1', first, 'edited mid-write');
    expect(addPlainNote('s1', 'added mid-write')).toBeNull();
    const captured = source();
    expect(addTerminalNote('s1', [{ text: 'boom' }], captured)).toBeNull();
    // Nobody else can reach the markers of a note that was never added.
    expect(captured.startMarker.dispose).toHaveBeenCalledTimes(1);
    expect(captured.endMarker.dispose).toHaveBeenCalledTimes(1);
    deleteNote('s1', first);
    expect(getNotes('s1').map((n) => n.content)).toEqual([{ kind: 'plain', text: 'snapshotted' }]);

    held.release();
    await closing;

    expect(isSurfaceClosing('s1')).toBe(false);
    const archive = await stored();
    expect(archive.batches).toHaveLength(1);
    expect(archive.batches[0].notes.map((n) => n.content)).toEqual([
      { kind: 'plain', text: 'snapshotted' },
    ]);
    expect(getNotes('s1')).toEqual([]);
  });

  it('archives one batch for two overlapping closures of one Surface', async () => {
    const held = heldSave();
    addPlainNote('s1', 'only once');

    const first = archiveSurfaceNotes(['s1']);
    const second = archiveSurfaceNotes(['s1']);
    await held.entered;
    held.release();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);

    const archive = await stored();
    expect(archive.batches).toHaveLength(1);
    expect(archive.batches[0].notes).toHaveLength(1);
    // Counted, not flagged: the freeze lifts only once *both* have settled.
    expect(isSurfaceClosing('s1')).toBe(false);
    expect(addPlainNote('s1', 'after')).not.toBeNull();
  });

  it('thaws the notepad when the write is refused', async () => {
    vi.spyOn(adapter.notepadArchive, 'save').mockRejectedValue(new Error('disk is full'));
    const id = addPlainNote('s1', 'still here')!;

    await expect(archiveSurfaceNotes(['s1'])).rejects.toThrow('disk is full');

    // The Surface stayed open behind Keep open, so its notepad is the user's
    // again.
    expect(isSurfaceClosing('s1')).toBe(false);
    setNoteText('s1', id, 'edited after the failure');
    expect(getNotes('s1')[0].content).toEqual({ kind: 'plain', text: 'edited after the failure' });
  });

  it('never archives an empty plain note', async () => {
    const save = vi.spyOn(adapter.notepadArchive, 'save');
    // An untouched Add New that was still focused when the kill landed.
    addPlainNote('s1');
    addPlainNote('s1', 'typed');
    // Nothing but an untouched Add New: this Surface closes as if it had none.
    addPlainNote('s2');

    await archiveSurfaceNotes(['s1', 's2']);

    expect(save).toHaveBeenCalledTimes(1);
    const archive = await stored();
    expect(archive.batches).toHaveLength(1);
    expect(archive.batches[0].notes.map((n) => n.content)).toEqual([{ kind: 'plain', text: 'typed' }]);
    expect(getNotes('s2')).toEqual([]);
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
