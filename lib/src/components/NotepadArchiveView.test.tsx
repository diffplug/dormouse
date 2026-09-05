/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPlatform } from '../lib/platform';
import { FakePtyAdapter } from '../lib/platform/fake-adapter';
import { __resetArchiveServiceForTests } from '../lib/notepad/archive-service';
import { clearAllNotepads } from '../lib/notepad/notepad-store';
import type { ArchiveBatch, ArchivedNote, NotepadArchiveV1 } from '../lib/notepad/types';
import type { CwdState } from '../lib/terminal-state';
import { NotepadArchiveView } from './NotepadArchiveView';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let platform: FakePtyAdapter;

/** Fixed timestamps: the header renders an absolute date, so a relative "now"
 *  would make these assertions drift with the clock. */
const JAN = Date.parse('2026-01-05T10:00:00Z');
const FEB = Date.parse('2026-02-05T10:00:00Z');
const MAR = Date.parse('2026-03-05T10:00:00Z');

const LOCAL_CWD: CwdState = {
  path: '/Users/ned/projects/dormouse',
  pathKind: 'posix',
  isRemote: false,
  source: 'osc7',
  updatedAt: JAN,
};

const REMOTE_CWD: CwdState = {
  path: '/srv/build/dormouse',
  host: 'build-box',
  scheme: 'file',
  pathKind: 'posix',
  isRemote: true,
  source: 'osc7',
  updatedAt: JAN,
};

function note(id: string, text: string): ArchivedNote {
  return { id, createdAt: JAN, content: { kind: 'plain', text } };
}

function batch(over: Partial<ArchiveBatch> & Pick<ArchiveBatch, 'id'>): ArchiveBatch {
  return {
    closedAt: JAN,
    surfaceTitle: over.id,
    surfaceKind: 'terminal',
    cwd: null,
    notes: [note(`${over.id}-n1`, `${over.id} first`)],
    ...over,
  };
}

function archive(...batches: ArchiveBatch[]): NotepadArchiveV1 {
  return { version: 1, batches };
}

function text(): string {
  return container.textContent ?? '';
}

function byLabel(label: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (!found) throw new Error(`no element labeled ${label}`);
  return found;
}

function buttons(label: string): HTMLButtonElement[] {
  return [...container.querySelectorAll('button')].filter(
    (button) => (button.textContent ?? '').trim() === label,
  );
}

function byText(label: string): HTMLButtonElement {
  const found = buttons(label)[0];
  if (!found) throw new Error(`no button reading ${label}`);
  return found;
}

/** Every batch title in render order — the assertion for newest-first. */
function batchTitles(): string[] {
  return [...container.querySelectorAll('section > div > span:first-child')].map(
    (span) => span.textContent ?? '',
  );
}

async function render(props: Partial<Parameters<typeof NotepadArchiveView>[0]> = {}) {
  await act(async () => {
    root.render(
      <NotepadArchiveView onBack={props.onBack ?? (() => {})} onClose={props.onClose ?? (() => {})} />,
    );
  });
  // The view loads on mount; let that settle before anything asserts on it.
  await act(async () => {});
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  platform = new FakePtyAdapter();
  setPlatform(platform);
  __resetArchiveServiceForTests();
  clearAllNotepads();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  __resetArchiveServiceForTests();
  clearAllNotepads();
  vi.restoreAllMocks();
});

describe('NotepadArchiveView', () => {
  it('shows the newest batch first, notes in their captured order', async () => {
    platform.notepadArchive.seed(
      archive(
        batch({ id: 'middle', surfaceTitle: 'middle', closedAt: FEB }),
        batch({ id: 'oldest', surfaceTitle: 'oldest', closedAt: JAN }),
        batch({
          id: 'newest',
          surfaceTitle: 'newest',
          closedAt: MAR,
          notes: [note('a', 'first note'), note('b', 'second note')],
        }),
      ),
    );

    await render();

    expect(batchTitles()).toEqual(['newest', 'middle', 'oldest']);
    expect(text().indexOf('first note')).toBeLessThan(text().indexOf('second note'));
  });

  it('renders a local CWD whole, a remote one with its host, and none at all', async () => {
    platform.notepadArchive.seed(
      archive(
        batch({ id: 'local', closedAt: MAR, cwd: LOCAL_CWD }),
        batch({ id: 'remote', closedAt: FEB, cwd: REMOTE_CWD }),
        batch({ id: 'browser', closedAt: JAN, surfaceKind: 'browser', cwd: null }),
      ),
    );

    await render();

    expect(text()).toContain('/Users/ned/projects/dormouse');
    expect(text()).toContain('build-box:/srv/build/dormouse');
    // The kind chip is the browser batch's only metadata beyond its title.
    expect(text()).toContain('browser');
  });

  it('hides a deleted note at once, and the batch once its last note is gone', async () => {
    platform.notepadArchive.seed(
      archive(
        batch({
          id: 'pair',
          surfaceTitle: 'pair',
          notes: [note('a', 'keep me'), note('b', 'delete me')],
        }),
      ),
    );

    await render();
    expect(text()).toContain('delete me');

    // Second note row: the buttons render in note order.
    const deletes = () => [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Delete note"]')];
    await act(async () => deletes()[1]?.click());
    expect(text()).not.toContain('delete me');
    expect(text()).toContain('keep me');
    expect(text()).toContain('Deletion is irreversible once this window closes.');

    await act(async () => deletes()[0]?.click());
    expect(batchTitles()).toEqual([]);
    expect(text()).not.toContain('keep me');
  });

  it('restores everything staged when Undo is pressed', async () => {
    platform.notepadArchive.seed(
      archive(
        batch({ id: 'one', surfaceTitle: 'one', closedAt: FEB }),
        batch({ id: 'two', surfaceTitle: 'two', closedAt: JAN }),
      ),
    );

    await render();
    await act(async () => byText('Delete batch').click());
    await act(async () => byLabel('Delete note').click());
    expect(batchTitles()).toEqual([]);

    await act(async () => byText('Undo').click());

    expect(batchTitles()).toEqual(['one', 'two']);
    expect(text()).not.toContain('Deletion is irreversible');
  });

  it('commits the whole staged set as one mutation on Back', async () => {
    platform.notepadArchive.seed(
      archive(
        batch({ id: 'gone', surfaceTitle: 'gone', closedAt: FEB }),
        batch({
          id: 'trimmed',
          surfaceTitle: 'trimmed',
          closedAt: JAN,
          notes: [note('a', 'keep me'), note('b', 'delete me')],
        }),
      ),
    );
    const save = vi.spyOn(platform.notepadArchive, 'save');
    const onBack = vi.fn();

    await render({ onBack });
    await act(async () => byText('Delete batch').click());
    const deletes = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Delete note"]')];
    await act(async () => deletes[1]?.click());

    await act(async () => byText('Back to Settings').click());

    expect(save).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);
    const stored = save.mock.calls[0]?.[0];
    expect(stored?.batches.map((entry) => entry.id)).toEqual(['trimmed']);
    expect(stored?.batches[0]?.notes.map((entry) => entry.id)).toEqual(['a']);
    // Cleared on a successful commit, so a host that later loses the webview
    // does not re-apply deletions that already landed.
    expect(platform.notepadArchive.lastVolatileSnapshot()?.stagedDeletions).toEqual({});
  });

  it('mirrors the staged set while the view is open', async () => {
    platform.notepadArchive.seed(archive(batch({ id: 'one' })));

    await render();
    await act(async () => byLabel('Delete note').click());

    expect(platform.notepadArchive.lastVolatileSnapshot()?.stagedDeletions).toEqual({
      deleteBatchIds: [],
      deleteNotes: [{ batchId: 'one', noteId: 'one-n1' }],
    });
  });

  it('stays open with its staged state when the commit fails', async () => {
    platform.notepadArchive.seed(
      archive(
        batch({
          id: 'pair',
          surfaceTitle: 'pair',
          notes: [note('a', 'keep me'), note('b', 'delete me')],
        }),
      ),
    );
    vi.spyOn(platform.notepadArchive, 'save').mockRejectedValue(new Error('disk is full'));
    const onBack = vi.fn();

    await render({ onBack });
    const deletes = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Delete note"]')];
    await act(async () => deletes[1]?.click());
    await act(async () => byText('Back to Settings').click());

    expect(onBack).not.toHaveBeenCalled();
    expect(text()).toContain('disk is full');
    // Still staged, and still hidden — the retry is pressing Back again.
    expect(text()).not.toContain('delete me');
    expect(text()).toContain('Deletion is irreversible once this window closes.');
    expect(byText('Back to Settings').disabled).toBe(false);
    expect(byText('Undo').disabled).toBe(false);
  });

  it('offers one recovery for an unreadable archive and never replaces it silently', async () => {
    platform.notepadArchive.corrupt();

    await render();
    expect(text()).toContain('could not be read');
    expect(text()).toContain('Nothing has been changed or replaced');

    await act(async () => byText('Move it aside and start a new archive').click());

    // The unreadable bytes were kept, not deleted, and the view is now an empty
    // archive rather than an error.
    expect(platform.notepadArchive.unreadableCopies()).toHaveLength(1);
    expect(text()).toContain('Nothing archived yet');
  });

  it('reports a load failure with a retry rather than an empty archive', async () => {
    const load = vi
      .spyOn(platform.notepadArchive, 'load')
      .mockRejectedValueOnce(new Error('storage unavailable'));

    await render();
    expect(text()).toContain('storage unavailable');

    load.mockRestore();
    platform.notepadArchive.seed(archive(batch({ id: 'back', surfaceTitle: 'back' })));
    await act(async () => byText('Retry').click());
    await act(async () => {});

    expect(batchTitles()).toEqual(['back']);
  });

  it('flashes a confirmation on the note it copied', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    platform.notepadArchive.seed(archive(batch({ id: 'one' })));

    await render();
    await act(async () => byLabel('Copy note').click());

    expect(writeText).toHaveBeenCalledWith('one first');
    expect(container.querySelector('[aria-label="Copied"]')).not.toBeNull();
    vi.unstubAllGlobals();
  });
});
