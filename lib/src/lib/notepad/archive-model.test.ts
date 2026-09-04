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

  it('drops unknown fields by projection', () => {
    const value = {
      version: 1,
      extra: 'ignored',
      batches: [
        {
          ...batch('b1', [{ id: 'n1', text: 'a' }]),
          surfaceLabel: 'ignored',
          notes: [{ id: 'n1', createdAt: 1, content: { kind: 'plain', text: 'a' }, source: { terminalId: 't1' } }],
        },
      ],
    };
    const read = readNotepadArchive(value);
    expect(read).not.toBeNull();
    expect(read).not.toHaveProperty('extra');
    expect(read!.batches[0]).not.toHaveProperty('surfaceLabel');
    expect(read!.batches[0].notes[0]).not.toHaveProperty('source');
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

  it('applies appends before deletes within one mutation', () => {
    const start = archive(batch('b1', [{ id: 'n1', text: 'a' }]));
    const next = applyArchiveMutation(start, {
      append: [batch('b2', [{ id: 'n2', text: 'b' }, { id: 'n3', text: 'c' }])],
      deleteNotes: [{ batchId: 'b2', noteId: 'n2' }],
    });
    expect(next.batches.map((b) => b.id)).toEqual(['b1', 'b2']);
    expect(next.batches[1].notes.map((n) => n.id)).toEqual(['n3']);
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
    // The projection survives validation, which is what the host will store.
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
