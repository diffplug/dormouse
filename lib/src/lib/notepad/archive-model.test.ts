import { describe, expect, it, vi } from 'vitest';
import type { IMarker } from '@xterm/xterm';
import type { CwdState } from '../terminal-state';
import {
  applyArchiveMutation,
  batchFromVolatile,
  buildArchiveBatch,
  isEmptyMutation,
  readCwdState,
  readNotepadArchive,
  toArchivedNote,
} from './archive-model';
import type { ArchiveBatch, LiveNote, NotepadArchiveV1, RuntimeTerminalSource } from './types';

const LOCAL_CWD: CwdState = {
  path: '/home/ned/projects',
  pathKind: 'posix',
  isRemote: false,
  source: 'osc7',
  updatedAt: 1_700_000_000_000,
};

const REMOTE_CWD: CwdState = {
  path: '/srv/app',
  uri: 'file://build-box/srv/app',
  host: 'build-box',
  scheme: 'file',
  pathKind: 'posix',
  isRemote: true,
  source: 'osc7',
  updatedAt: 1_700_000_000_001,
};

function batch(id: string, notes: Array<{ id: string; text: string }>, cwd: CwdState | null = LOCAL_CWD): ArchiveBatch {
  return {
    id,
    closedAt: 1_700_000_000_000,
    surfaceTitle: `pane ${id}`,
    surfaceKind: 'terminal',
    cwd,
    notes: notes.map((note) => ({
      id: note.id,
      createdAt: 1_700_000_000_000,
      content: { kind: 'plain', text: note.text },
    })),
  };
}

function archive(...batches: ArchiveBatch[]): NotepadArchiveV1 {
  return { version: 1, batches };
}

describe('readNotepadArchive', () => {
  it('accepts a valid archive', () => {
    const value = archive(batch('b1', [{ id: 'n1', text: 'hello' }]));
    expect(readNotepadArchive(value)).toEqual(value);
  });

  it('accepts the JSON-string form a host state API may hand back', () => {
    const value = archive(batch('b1', [{ id: 'n1', text: 'hello' }]), batch('b2', [], null));
    expect(readNotepadArchive(JSON.stringify(value))).toEqual(value);
  });

  it('rejects a string that is not JSON', () => {
    expect(readNotepadArchive('{ not json')).toBeNull();
  });

  it('rejects a missing or wrong version', () => {
    expect(readNotepadArchive({ batches: [] })).toBeNull();
    expect(readNotepadArchive({ version: 2, batches: [] })).toBeNull();
    expect(readNotepadArchive(null)).toBeNull();
    expect(readNotepadArchive({ version: 1 })).toBeNull();
  });

  it('rejects a run whose color is not a normalized hex triple', () => {
    const rich = {
      version: 1,
      batches: [
        {
          ...batch('b1', []),
          notes: [
            {
              id: 'n1',
              createdAt: 1,
              content: { kind: 'terminal', runs: [{ text: 'x', foreground: 'red' }] },
            },
          ],
        },
      ],
    };
    expect(readNotepadArchive(rich)).toBeNull();
    rich.batches[0].notes[0].content.runs[0].foreground = '#FF0000';
    expect(readNotepadArchive(rich), 'uppercase is not normalized').toBeNull();
    rich.batches[0].notes[0].content.runs[0].foreground = '#ff0000';
    expect(readNotepadArchive(rich)).not.toBeNull();
  });

  it('rejects a batch whose cwd is the wrong shape', () => {
    const bad = { ...batch('b1', [{ id: 'n1', text: 'x' }]), cwd: { path: '/tmp' } };
    expect(readNotepadArchive({ version: 1, batches: [bad] })).toBeNull();
  });

  it('rejects duplicate batch ids outright', () => {
    const value = archive(batch('b1', [{ id: 'n1', text: 'a' }]), batch('b1', [{ id: 'n2', text: 'b' }]));
    expect(readNotepadArchive(value)).toBeNull();
  });

  it('rejects an unknown field at every level', () => {
    // Not dropped: every mutation rewrites the whole archive from what was read
    // back, so a field only a newer build understands would be erased on the
    // next save. Refusing makes it a reported failure instead of silent loss.
    const one = batch('b1', [{ id: 'n1', text: 'a' }]);
    const wrap = (b: unknown) => ({ version: 1, batches: [b] });
    expect(readNotepadArchive(wrap(one))).not.toBeNull();

    expect(readNotepadArchive({ version: 1, batches: [one], extra: 'x' }), 'archive').toBeNull();
    expect(readNotepadArchive(wrap({ ...one, surfaceLabel: 'x' })), 'batch').toBeNull();
    expect(readNotepadArchive(wrap({ ...one, cwd: { ...LOCAL_CWD, drive: 'C:' } })), 'cwd').toBeNull();
    expect(readCwdState({ ...LOCAL_CWD, drive: 'C:' }), 'cwd on its own').toBeNull();
    expect(
      readNotepadArchive(wrap({ ...one, notes: [{ ...one.notes[0], source: { terminalId: 't1' } }] })),
      'note',
    ).toBeNull();
    expect(
      readNotepadArchive(
        wrap({ ...one, notes: [{ ...one.notes[0], content: { kind: 'plain', text: 'a', html: '<b>a</b>' } }] }),
      ),
      'content',
    ).toBeNull();
    expect(
      readNotepadArchive(
        wrap({
          ...one,
          notes: [{ ...one.notes[0], content: { kind: 'terminal', runs: [{ text: 'a', underline: true }] } }],
        }),
      ),
      'run',
    ).toBeNull();
  });
});

describe('readCwdState', () => {
  it('reads a local cwd', () => {
    expect(readCwdState(LOCAL_CWD)).toEqual(LOCAL_CWD);
  });

  it('reads a remote cwd with its host and uri', () => {
    expect(readCwdState(REMOTE_CWD)).toEqual(REMOTE_CWD);
  });

  it('rejects a bad source, path kind, or scheme', () => {
    expect(readCwdState({ ...LOCAL_CWD, source: 'guess' })).toBeNull();
    expect(readCwdState({ ...LOCAL_CWD, pathKind: 'dos' })).toBeNull();
    expect(readCwdState({ ...LOCAL_CWD, scheme: 'https' })).toBeNull();
    expect(readCwdState(null)).toBeNull();
  });

  it('leaves a null cwd to the batch reader, which keeps it', () => {
    expect(readCwdState(null)).toBeNull();
    const read = readNotepadArchive(archive(batch('b1', [{ id: 'n1', text: 'a' }], null)));
    expect(read!.batches[0].cwd).toBeNull();
  });

  it('keeps a remote cwd through a whole archive round trip', () => {
    const read = readNotepadArchive(JSON.stringify(archive(batch('b1', [{ id: 'n1', text: 'a' }], REMOTE_CWD))));
    expect(read!.batches[0].cwd).toEqual(REMOTE_CWD);
  });
});

describe('applyArchiveMutation', () => {
  it('appends, and appending a batch id already present is a no-op', () => {
    const start = archive(batch('b1', [{ id: 'n1', text: 'a' }]));
    const appended = applyArchiveMutation(start, { append: [batch('b2', [{ id: 'n2', text: 'b' }])] });
    expect(appended.batches.map((b) => b.id)).toEqual(['b1', 'b2']);
    const again = applyArchiveMutation(appended, { append: [batch('b2', [{ id: 'n2', text: 'changed' }])] });
    expect(again.batches).toEqual(appended.batches);
  });

  it('skips an appended batch whose notes are all already stored', () => {
    // A write that landed but reported failure is retried under a *fresh* batch
    // id, so batch-id idempotence alone would duplicate every note in it.
    const start = archive(batch('b1', [{ id: 'n1', text: 'a' }]));
    const next = applyArchiveMutation(start, { append: [batch('b2', [{ id: 'n1', text: 'a' }])] });
    expect(next.batches.map((b) => b.id)).toEqual(['b1']);
  });

  it('keeps only the new notes when an appended batch partly overlaps', () => {
    // The Surface stayed open after the reported failure and the user kept
    // typing: the second attempt must land exactly what the first did not.
    const start = archive(batch('b1', [{ id: 'n1', text: 'a' }]));
    const next = applyArchiveMutation(start, {
      append: [batch('b2', [{ id: 'n1', text: 'a' }, { id: 'n2', text: 'b' }])],
    });
    expect(next.batches.map((b) => b.id)).toEqual(['b1', 'b2']);
    expect(next.batches[1].notes.map((n) => n.id)).toEqual(['n2']);
  });

  it('deduplicates note ids across two batches appended together', () => {
    const next = applyArchiveMutation(archive(), {
      append: [batch('b1', [{ id: 'n1', text: 'a' }]), batch('b2', [{ id: 'n1', text: 'a' }])],
    });
    expect(next.batches.map((b) => b.id)).toEqual(['b1']);
  });

  it('deletes whole batches', () => {
    const start = archive(batch('b1', [{ id: 'n1', text: 'a' }]), batch('b2', [{ id: 'n2', text: 'b' }]));
    const next = applyArchiveMutation(start, { deleteBatchIds: ['b1', 'gone'] });
    expect(next.batches.map((b) => b.id)).toEqual(['b2']);
  });

  it('deletes individual notes and keeps the rest in order', () => {
    const start = archive(
      batch('b1', [
        { id: 'n1', text: 'a' },
        { id: 'n2', text: 'b' },
        { id: 'n3', text: 'c' },
      ]),
    );
    const next = applyArchiveMutation(start, { deleteNotes: [{ batchId: 'b1', noteId: 'n2' }] });
    expect(next.batches[0].notes.map((n) => n.id)).toEqual(['n1', 'n3']);
  });

  it('drops a batch emptied by note deletes', () => {
    const start = archive(batch('b1', [{ id: 'n1', text: 'a' }]), batch('b2', [{ id: 'n2', text: 'b' }]));
    const next = applyArchiveMutation(start, {
      deleteNotes: [{ batchId: 'b1', noteId: 'n1' }],
    });
    expect(next.batches.map((b) => b.id)).toEqual(['b2']);
  });

  it('is a fixpoint: applying the same mutation twice changes nothing', () => {
    const start = archive(batch('b1', [{ id: 'n1', text: 'a' }, { id: 'n2', text: 'b' }]));
    const mutation = {
      append: [batch('b2', [{ id: 'n3', text: 'c' }])],
      deleteBatchIds: ['gone'],
      deleteNotes: [{ batchId: 'b1', noteId: 'n1' }],
    };
    const once = applyArchiveMutation(start, mutation);
    const twice = applyArchiveMutation(once, mutation);
    expect(twice).toEqual(once);
  });

  it('applies deletes before appends within one mutation', () => {
    const start = archive(batch('b1', [{ id: 'n1', text: 'a' }]));
    const next = applyArchiveMutation(start, {
      append: [batch('b2', [{ id: 'n2', text: 'b' }, { id: 'n3', text: 'c' }])],
      deleteNotes: [{ batchId: 'b2', noteId: 'n2' }],
    });
    // The delete names a batch that is not stored yet, so it is a no-op and the
    // appended batch lands whole.
    expect(next.batches.map((b) => b.id)).toEqual(['b1', 'b2']);
    expect(next.batches[1].notes.map((n) => n.id)).toEqual(['n2', 'n3']);
  });

  it('replaces a batch deleted and re-appended under one id', () => {
    // A closure retried after a write that landed and then reported failure: the
    // user edited n1, added n3, and deleted n2 while the Surface stayed open.
    const start = archive(batch('b1', [{ id: 'n1', text: 'a' }, { id: 'n2', text: 'b' }]));
    const next = applyArchiveMutation(start, {
      deleteBatchIds: ['b1'],
      append: [batch('b1', [{ id: 'n1', text: 'edited' }, { id: 'n3', text: 'c' }])],
    });

    expect(next.batches.map((b) => b.id)).toEqual(['b1']);
    // The dedupe runs after the deletes, so the replaced batch's copy of n1 is
    // not "already stored" and the edited one is what survives.
    expect(next.batches[0].notes.map((n) => [n.id, n.content])).toEqual([
      ['n1', { kind: 'plain', text: 'edited' }],
      ['n3', { kind: 'plain', text: 'c' }],
    ]);
  });

  it('still dedupes a note against a batch the mutation is not replacing', () => {
    // The VS Code mirror path mints a fresh batch id per teardown and relies on
    // this: nothing addresses the batch its notes may already be sitting in.
    const start = archive(batch('b1', [{ id: 'n1', text: 'a' }]));
    const next = applyArchiveMutation(start, {
      deleteBatchIds: ['b2'],
      append: [batch('b3', [{ id: 'n1', text: 'a' }, { id: 'n2', text: 'b' }])],
    });
    expect(next.batches.map((b) => b.id)).toEqual(['b1', 'b3']);
    expect(next.batches[1].notes.map((n) => n.id)).toEqual(['n2']);
  });

  it('does not mutate the archive it was given', () => {
    const start = archive(batch('b1', [{ id: 'n1', text: 'a' }]));
    const before = JSON.stringify(start);
    applyArchiveMutation(start, { append: [batch('b2', [])], deleteBatchIds: ['b1'] });
    expect(JSON.stringify(start)).toBe(before);
  });

  it('recognizes an empty mutation', () => {
    expect(isEmptyMutation({})).toBe(true);
    expect(isEmptyMutation({ append: [], deleteBatchIds: [], deleteNotes: [] })).toBe(true);
    expect(isEmptyMutation({ deleteBatchIds: ['b1'] })).toBe(false);
  });
});

function fakeMarker(): IMarker {
  return { id: 1, line: 4, isDisposed: false, dispose: vi.fn(), onDispose: vi.fn() } as unknown as IMarker;
}

function fakeSource(terminalId = 't1'): RuntimeTerminalSource {
  return {
    terminalId,
    startMarker: fakeMarker(),
    endMarker: fakeMarker(),
    startColumn: 0,
    endColumn: 10,
    shape: 'linewise',
    expectedRawText: 'hello',
  };
}

describe('buildArchiveBatch', () => {
  it('strips the runtime source from every note', () => {
    const notes: LiveNote[] = [
      { id: 'n1', createdAt: 1, content: { kind: 'terminal', runs: [{ text: 'hello', bold: true }] }, source: fakeSource() },
      { id: 'n2', createdAt: 2, content: { kind: 'plain', text: 'typed' } },
    ];
    const built = buildArchiveBatch({
      id: 'b1',
      closedAt: 9,
      surfaceTitle: 'zsh',
      surfaceKind: 'terminal',
      cwd: LOCAL_CWD,
      notes,
    });
    expect(built.notes).toEqual([
      { id: 'n1', createdAt: 1, content: { kind: 'terminal', runs: [{ text: 'hello', bold: true }] } },
      { id: 'n2', createdAt: 2, content: { kind: 'plain', text: 'typed' } },
    ]);
    expect(built.notes[0]).not.toHaveProperty('source');
    // What the builder emits reads back, which is what the host will store —
    // and under strict keys that also pins that it emits no field the reader
    // would refuse.
    expect(readNotepadArchive({ version: 1, batches: [built] })).not.toBeNull();
  });

  it('toArchivedNote drops the source but keeps id, time, and content', () => {
    const note: LiveNote = { id: 'n1', createdAt: 5, content: { kind: 'plain', text: 'x' }, source: fakeSource() };
    expect(toArchivedNote(note)).toEqual({ id: 'n1', createdAt: 5, content: { kind: 'plain', text: 'x' } });
  });
});

describe('batchFromVolatile', () => {
  it('returns null when the mirrored Surface has no notes', () => {
    expect(
      batchFromVolatile(
        { surfaceId: 's1', surfaceTitle: 'zsh', surfaceKind: 'terminal', cwd: null, notes: [] },
        'b1',
        9,
      ),
    ).toBeNull();
  });

  it('builds a batch carrying the mirrored metadata', () => {
    const built = batchFromVolatile(
      {
        surfaceId: 's1',
        surfaceTitle: 'build',
        surfaceKind: 'terminal',
        cwd: REMOTE_CWD,
        notes: [{ id: 'n1', createdAt: 1, content: { kind: 'plain', text: 'x' } }],
      },
      'b1',
      9,
    );
    expect(built).toEqual({
      id: 'b1',
      closedAt: 9,
      surfaceTitle: 'build',
      surfaceKind: 'terminal',
      cwd: REMOTE_CWD,
      notes: [{ id: 'n1', createdAt: 1, content: { kind: 'plain', text: 'x' } }],
    });
  });
});
