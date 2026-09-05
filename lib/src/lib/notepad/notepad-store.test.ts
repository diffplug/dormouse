import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IMarker } from '@xterm/xterm';
import { FakePtyAdapter, setPlatform } from '../platform';
import type { CwdState } from '../terminal-state';
import {
  addPlainNote,
  addTerminalNote,
  beginClosing,
  buildVolatileSnapshot,
  clearAllNotepads,
  deleteNote,
  dropSource,
  dropSourcesForTerminal,
  getNotepadSnapshot,
  getNotes,
  getOpenNotepadId,
  hydrateNotepadFromVolatile,
  isSurfaceClosing,
  noteCount,
  pendingBatchId,
  pruneEmptyNote,
  removeSurface,
  setNotepadSurfaceMetaResolver,
  setNoteText,
  setOpenNotepadId,
  setStagedArchiveDeletions,
  subscribeToNotepad,
  subscribeToOpenNotepad,
  transferNotepad,
} from './notepad-store';
import type { RuntimeTerminalSource } from './types';

let adapter: FakePtyAdapter;

/** One microtask tick — the volatile sync is coalesced onto the microtask
 *  queue, so a test that asserts on it has to let that run. */
const flush = (): Promise<void> => Promise.resolve();

function marker(): IMarker & { dispose: ReturnType<typeof vi.fn> } {
  return { id: 1, line: 3, isDisposed: false, dispose: vi.fn(), onDispose: vi.fn() } as unknown as IMarker & {
    dispose: ReturnType<typeof vi.fn>;
  };
}

function source(terminalId = 'term-1'): RuntimeTerminalSource {
  return {
    terminalId,
    startMarker: marker(),
    endMarker: marker(),
    startColumn: 0,
    endColumn: 12,
    shape: 'linewise',
    expectedRawText: 'error: boom',
  };
}

beforeEach(async () => {
  clearAllNotepads();
  adapter = new FakePtyAdapter();
  setPlatform(adapter);
  await flush();
});

describe('notes', () => {
  it('adds, edits, deletes, and keeps creation order', () => {
    const first = addPlainNote('s1', 'one');
    const second = addPlainNote('s1');
    const third = addTerminalNote('s1', [{ text: 'boom', bold: true }]);
    expect(getNotes('s1').map((n) => n.id)).toEqual([first, second, third]);
    expect(noteCount('s1')).toBe(3);

    setNoteText('s1', second, 'two');
    expect(getNotes('s1')[1].content).toEqual({ kind: 'plain', text: 'two' });

    deleteNote('s1', second);
    expect(getNotes('s1').map((n) => n.id)).toEqual([first, third]);
    expect(noteCount('s2')).toBe(0);
    expect(getNotes('s2')).toEqual([]);
  });

  it('keeps Surfaces separate and forgets a Surface with no notes left', () => {
    addPlainNote('s1', 'a');
    const other = addPlainNote('s2', 'b');
    expect(getNotepadSnapshot().size).toBe(2);
    deleteNote('s2', other);
    expect(getNotepadSnapshot().has('s2')).toBe(false);
    expect(getNotes('s1')).toHaveLength(1);
  });

  it('notifies subscribers and hands out a stable snapshot between changes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToNotepad(listener);
    const before = getNotepadSnapshot();
    expect(getNotepadSnapshot()).toBe(before);

    addPlainNote('s1', 'a');
    expect(listener).toHaveBeenCalledTimes(1);
    const after = getNotepadSnapshot();
    expect(after).not.toBe(before);
    expect(getNotepadSnapshot()).toBe(after);

    unsubscribe();
    addPlainNote('s1', 'b');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('rich to plain conversion', () => {
  it('converts only when the text actually changes', () => {
    const id = addTerminalNote('s1', [{ text: 'boom', foreground: '#ff0000' }]);

    // Reading, focusing, moving the caret: none of that reaches the store.
    expect(getNotes('s1')[0].content).toEqual({ kind: 'terminal', runs: [{ text: 'boom', foreground: '#ff0000' }] });
    expect(noteCount('s1')).toBe(1);

    setNoteText('s1', id, 'boomm');
    expect(getNotes('s1')[0].content).toEqual({ kind: 'plain', text: 'boomm' });
  });

  it('leaves a plain note alone when the text is unchanged', () => {
    const id = addPlainNote('s1', 'same');
    const before = getNotes('s1')[0];
    setNoteText('s1', id, 'same');
    expect(getNotes('s1')[0]).toBe(before);
  });

  it('keeps the source link across the conversion', () => {
    const src = source();
    const id = addTerminalNote('s1', [{ text: 'boom' }], src);
    setNoteText('s1', id, 'edited');
    expect(getNotes('s1')[0].source).toBe(src);
    expect(src.startMarker.dispose).not.toHaveBeenCalled();
  });

  it('ignores an unknown Surface or note', () => {
    setNoteText('nope', 'nope', 'x');
    const id = addPlainNote('s1', 'a');
    setNoteText('s1', 'other', 'x');
    expect(getNotes('s1')[0].content).toEqual({ kind: 'plain', text: 'a' });
    expect(id).toBeTruthy();
  });
});

describe('pruneEmptyNote', () => {
  it('removes an untouched empty plain note', () => {
    const id = addPlainNote('s1');
    expect(pruneEmptyNote('s1', id)).toBe(true);
    expect(noteCount('s1')).toBe(0);
  });

  it('keeps a note with text and a rich note that was never edited', () => {
    const typed = addPlainNote('s1', 'x');
    const rich = addTerminalNote('s1', []);
    expect(pruneEmptyNote('s1', typed)).toBe(false);
    expect(pruneEmptyNote('s1', rich)).toBe(false);
    expect(pruneEmptyNote('s1', 'gone')).toBe(false);
    expect(noteCount('s1')).toBe(2);
  });
});

describe('source links', () => {
  it('dropSource disposes both markers and leaves the note', () => {
    const src = source();
    const id = addTerminalNote('s1', [{ text: 'boom' }], src);
    dropSource('s1', id);
    expect(src.startMarker.dispose).toHaveBeenCalledTimes(1);
    expect(src.endMarker.dispose).toHaveBeenCalledTimes(1);
    expect(getNotes('s1')).toHaveLength(1);
    expect(getNotes('s1')[0].source).toBeUndefined();
    // Idempotent: a second drop finds nothing to dispose.
    dropSource('s1', id);
    expect(src.startMarker.dispose).toHaveBeenCalledTimes(1);
  });

  it('dropSourcesForTerminal clears every pin into that terminal, across Surfaces', () => {
    const doomed = source('term-1');
    const alsoDoomed = source('term-1');
    const survivor = source('term-2');
    addTerminalNote('s1', [{ text: 'a' }], doomed);
    addPlainNote('s1', 'typed');
    addTerminalNote('s2', [{ text: 'b' }], alsoDoomed);
    addTerminalNote('s2', [{ text: 'c' }], survivor);

    const listener = vi.fn();
    subscribeToNotepad(listener);
    dropSourcesForTerminal('term-1');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(doomed.startMarker.dispose).toHaveBeenCalled();
    expect(alsoDoomed.endMarker.dispose).toHaveBeenCalled();
    expect(survivor.startMarker.dispose).not.toHaveBeenCalled();
    expect(getNotes('s1').map((n) => n.source)).toEqual([undefined, undefined]);
    expect(getNotes('s2').map((n) => n.source)).toEqual([undefined, survivor]);

    // Nothing left to drop: no second notification.
    dropSourcesForTerminal('term-1');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('deleting a note disposes the markers it owned', () => {
    const src = source();
    const id = addTerminalNote('s1', [{ text: 'a' }], src);
    deleteNote('s1', id);
    expect(src.startMarker.dispose).toHaveBeenCalledTimes(1);
    expect(src.endMarker.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('surface lifecycle', () => {
  it('transferNotepad moves the notes and drops pins into the replaced terminal', () => {
    const oldPin = source('old');
    const otherPin = source('other');
    addTerminalNote('old', [{ text: 'a' }], oldPin);
    addTerminalNote('old', [{ text: 'b' }], otherPin);
    addPlainNote('old', 'typed');
    setOpenNotepadId('old');

    transferNotepad('old', 'new');

    expect(getNotes('old')).toEqual([]);
    expect(getNotes('new').map((n) => n.content)).toEqual([
      { kind: 'terminal', runs: [{ text: 'a' }] },
      { kind: 'terminal', runs: [{ text: 'b' }] },
      { kind: 'plain', text: 'typed' },
    ]);
    expect(oldPin.startMarker.dispose).toHaveBeenCalled();
    expect(getNotes('new')[0].source).toBeUndefined();
    // A pin into some other terminal is still live; only the replaced one goes.
    expect(getNotes('new')[1].source).toBe(otherPin);
    expect(otherPin.startMarker.dispose).not.toHaveBeenCalled();
    // The open panel follows the Surface to its new id.
    expect(getOpenNotepadId()).toBe('new');
  });

  it('transferNotepad moves the open panel even when there are no notes to carry', () => {
    // The old id stops existing either way, so an open panel left pointing at it
    // would be stranded on a Surface that is gone.
    setOpenNotepadId('old');

    transferNotepad('old', 'new');

    expect(getOpenNotepadId()).toBe('new');
  });

  it('transferNotepad is a no-op for an empty or self-referential move', () => {
    const listener = vi.fn();
    subscribeToNotepad(listener);
    transferNotepad('empty', 'new');
    addPlainNote('s1', 'a');
    transferNotepad('s1', 's1');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getNotes('s1')).toHaveLength(1);
  });

  it('removeSurface forgets the notes, disposes markers, and closes its panel', () => {
    const src = source();
    addTerminalNote('s1', [{ text: 'a' }], src);
    setOpenNotepadId('s1');
    removeSurface('s1');
    expect(src.startMarker.dispose).toHaveBeenCalledTimes(1);
    expect(src.endMarker.dispose).toHaveBeenCalledTimes(1);
    expect(getNotes('s1')).toEqual([]);
    expect(getNotepadSnapshot().has('s1')).toBe(false);
    expect(getOpenNotepadId()).toBeNull();
  });
});

describe('pendingBatchId', () => {
  it('is remembered per Surface until that Surface is removed', () => {
    const id = pendingBatchId('s1');
    expect(pendingBatchId('s1')).toBe(id);
    expect(pendingBatchId('s2')).not.toBe(id);

    // The closure landed, so the next one is a new batch rather than a
    // replacement.
    removeSurface('s1');
    expect(pendingBatchId('s1')).not.toBe(id);
  });

  it('follows an in-place replacement to the new Surface id', () => {
    const id = pendingBatchId('old');
    addPlainNote('old', 'a');

    transferNotepad('old', 'new');

    // Whatever an earlier attempt landed is still addressable under the id the
    // notes now live on.
    expect(pendingBatchId('new')).toBe(id);
    expect(pendingBatchId('old')).not.toBe(id);
  });

  it('follows a replacement that carries no notes at all', () => {
    const id = pendingBatchId('old');
    transferNotepad('old', 'new');
    expect(pendingBatchId('new')).toBe(id);
  });
});

describe('the closure freeze', () => {
  it('refuses every content mutation until the release runs', () => {
    const src = source('s1');
    const kept = addPlainNote('s1', 'snapshotted')!;
    const blank = addPlainNote('s1')!;
    const pinned = addTerminalNote('s1', [{ text: 'boom' }], src)!;

    const release = beginClosing(['s1']);
    expect(isSurfaceClosing('s1')).toBe(true);

    expect(addPlainNote('s1', 'nope')).toBeNull();
    const refused = source('s1');
    expect(addTerminalNote('s1', [{ text: 'nope' }], refused)).toBeNull();
    // Nothing else can reach the markers of a note that was never added.
    expect(refused.startMarker.dispose).toHaveBeenCalledTimes(1);
    expect(refused.endMarker.dispose).toHaveBeenCalledTimes(1);
    setNoteText('s1', kept, 'edited');
    deleteNote('s1', kept);
    // Even the blur prune stands down: the batch already holds this note.
    expect(pruneEmptyNote('s1', blank)).toBe(false);
    dropSource('s1', pinned);
    transferNotepad('s1', 'new');

    expect(getNotes('s1').map((n) => n.content)).toEqual([
      { kind: 'plain', text: 'snapshotted' },
      { kind: 'plain', text: '' },
      { kind: 'terminal', runs: [{ text: 'boom' }] },
    ]);
    expect(getNotes('s1')[2].source).toBe(src);
    expect(getNotes('new')).toEqual([]);

    release();
    expect(isSurfaceClosing('s1')).toBe(false);
    setNoteText('s1', kept, 'edited');
    expect(getNotes('s1')[0].content).toEqual({ kind: 'plain', text: 'edited' });
  });

  it('counts overlapping closures, and a double release thaws nothing extra', () => {
    const first = beginClosing(['s1']);
    const second = beginClosing(['s1']);

    first();
    first();
    expect(isSurfaceClosing('s1')).toBe(true);

    second();
    expect(isSurfaceClosing('s1')).toBe(false);
  });

  it('lets the teardown paths through, and wakes note subscribers', () => {
    const src = source('term-1');
    addTerminalNote('s1', [{ text: 'boom' }], src);
    const listener = vi.fn();
    subscribeToNotepad(listener);

    // The freeze itself is a notification: the panel has to go read-only.
    const release = beginClosing(['s1']);
    expect(listener).toHaveBeenCalledTimes(1);

    // The coordinator's own forget step, and the teardown paths that run
    // whatever a closure is doing.
    dropSourcesForTerminal('term-1');
    expect(getNotes('s1')[0].source).toBeUndefined();
    hydrateNotepadFromVolatile(
      {
        surfaces: [{ surfaceId: 's2', surfaceTitle: '', surfaceKind: 'terminal', cwd: null, notes: [{ id: 'n1', createdAt: 1, content: { kind: 'plain', text: 'live resume' } }] }],
        stagedDeletions: {},
      },
      ['s2'],
    );
    expect(getNotes('s2')).toHaveLength(1);
    removeSurface('s1');
    expect(getNotes('s1')).toEqual([]);

    release();
    // Still frozen for nobody: clearAllNotepads forgets the map outright.
    beginClosing(['s3']);
    clearAllNotepads();
    expect(isSurfaceClosing('s3')).toBe(false);
  });
});

describe('open panel', () => {
  it('holds one id at a time and notifies its own subscribers', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToOpenNotepad(listener);
    expect(getOpenNotepadId()).toBeNull();

    setOpenNotepadId('s1');
    expect(getOpenNotepadId()).toBe('s1');
    setOpenNotepadId('s1');
    expect(listener).toHaveBeenCalledTimes(1);

    setOpenNotepadId('s2');
    expect(getOpenNotepadId()).toBe('s2');
    setOpenNotepadId(null);
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    setOpenNotepadId('s3');
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('does not wake note subscribers', () => {
    const listener = vi.fn();
    subscribeToNotepad(listener);
    setOpenNotepadId('s1');
    expect(listener).not.toHaveBeenCalled();
  });
});

const CWD: CwdState = {
  path: '/srv/app',
  pathKind: 'posix',
  isRemote: false,
  source: 'osc7',
  updatedAt: 5,
};

describe('volatile mirror', () => {
  it('mirrors every Surface holding notes, without markers, once per burst', async () => {
    const sync = vi.spyOn(adapter.notepadArchive, 'syncVolatile');
    setNotepadSurfaceMetaResolver((surfaceId) =>
      surfaceId === 's1' ? { surfaceTitle: 'zsh', surfaceKind: 'terminal', cwd: CWD } : null,
    );

    const src = source();
    addTerminalNote('s1', [{ text: 'boom', bold: true }], src);
    addPlainNote('s1', 'typed');
    addPlainNote('s2', 'elsewhere');
    await flush();

    // A burst of edits is one snapshot, not one per keystroke.
    expect(sync).toHaveBeenCalledTimes(1);
    const snapshot = adapter.notepadArchive.lastVolatileSnapshot()!;
    expect(snapshot.surfaces).toEqual([
      {
        surfaceId: 's1',
        surfaceTitle: 'zsh',
        surfaceKind: 'terminal',
        cwd: CWD,
        notes: [
          { id: expect.any(String), createdAt: expect.any(Number), content: { kind: 'terminal', runs: [{ text: 'boom', bold: true }] } },
          { id: expect.any(String), createdAt: expect.any(Number), content: { kind: 'plain', text: 'typed' } },
        ],
      },
      {
        // No resolver answer yet: empty metadata rather than a missing Surface.
        surfaceId: 's2',
        surfaceTitle: '',
        surfaceKind: 'terminal',
        cwd: null,
        notes: [{ id: expect.any(String), createdAt: expect.any(Number), content: { kind: 'plain', text: 'elsewhere' } }],
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('startMarker');
  });

  it('carries staged archive deletions', async () => {
    setStagedArchiveDeletions({ deleteBatchIds: ['b1'], deleteNotes: [{ batchId: 'b2', noteId: 'n7' }] });
    addPlainNote('s1', 'a');
    await flush();
    expect(adapter.notepadArchive.lastVolatileSnapshot()!.stagedDeletions).toEqual({
      deleteBatchIds: ['b1'],
      deleteNotes: [{ batchId: 'b2', noteId: 'n7' }],
    });
  });

  it('drops a Surface from the mirror once its last note goes', async () => {
    const id = addPlainNote('s1', 'a');
    await flush();
    expect(adapter.notepadArchive.lastVolatileSnapshot()!.surfaces).toHaveLength(1);
    deleteNote('s1', id);
    await flush();
    expect(adapter.notepadArchive.lastVolatileSnapshot()!.surfaces).toEqual([]);
  });

  it('keeps working on a host with no archive port at all', async () => {
    const bare = new FakePtyAdapter();
    delete (bare as { notepadArchive?: unknown }).notepadArchive;
    setPlatform(bare);
    addPlainNote('s1', 'a');
    await expect(flush()).resolves.toBeUndefined();
    expect(buildVolatileSnapshot().surfaces).toHaveLength(1);
  });
});

describe('hydrateNotepadFromVolatile', () => {
  it('restores only live Surfaces, and never over an existing notepad', () => {
    addPlainNote('live-with-notes', 'already here');
    hydrateNotepadFromVolatile(
      {
        surfaces: [
          {
            surfaceId: 'live',
            surfaceTitle: 'zsh',
            surfaceKind: 'terminal',
            cwd: null,
            notes: [{ id: 'n1', createdAt: 1, content: { kind: 'terminal', runs: [{ text: 'boom' }] } }],
          },
          {
            surfaceId: 'dead',
            surfaceTitle: 'gone',
            surfaceKind: 'terminal',
            cwd: null,
            notes: [{ id: 'n2', createdAt: 2, content: { kind: 'plain', text: 'lost' } }],
          },
          {
            surfaceId: 'live-with-notes',
            surfaceTitle: 'zsh',
            surfaceKind: 'terminal',
            cwd: null,
            notes: [{ id: 'n3', createdAt: 3, content: { kind: 'plain', text: 'stale' } }],
          },
        ],
        stagedDeletions: {},
      },
      ['live', 'live-with-notes'],
    );

    expect(getNotes('live').map((n) => n.id)).toEqual(['n1']);
    // Restored notes carry no source: the markers died with the old webview.
    expect(getNotes('live')[0].source).toBeUndefined();
    expect(getNotes('dead')).toEqual([]);
    expect(getNotes('live-with-notes').map((n) => n.content)).toEqual([{ kind: 'plain', text: 'already here' }]);
  });

  it('does not notify when there is nothing to restore', () => {
    const listener = vi.fn();
    subscribeToNotepad(listener);
    hydrateNotepadFromVolatile({ surfaces: [], stagedDeletions: {} }, ['live']);
    hydrateNotepadFromVolatile(
      {
        surfaces: [{ surfaceId: 'live', surfaceTitle: '', surfaceKind: 'terminal', cwd: null, notes: [] }],
        stagedDeletions: {},
      },
      ['live'],
    );
    expect(listener).not.toHaveBeenCalled();
  });
});
