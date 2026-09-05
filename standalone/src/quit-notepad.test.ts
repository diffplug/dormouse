import { afterEach, expect, it, vi } from 'vitest';
import { FakePtyAdapter, setPlatform } from 'dormouse-lib/lib/platform';
import { __resetArchiveServiceForTests } from 'dormouse-lib/lib/notepad/archive-service';
import { addPlainNote, clearAllNotepads, deleteNote, getNotepadSnapshot, getNotes } from 'dormouse-lib/lib/notepad/notepad-store';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('dormouse-lib/lib/terminal-registry', () => ({ countRunningSessions: () => 0 }));
vi.mock('./updater', () => ({ hasPendingUpdate: () => false, installPendingUpdate: vi.fn() }));

import { archiveNotesBeforeQuit } from './quit';

afterEach(() => {
  vi.useRealTimers();
  clearAllNotepads();
  __resetArchiveServiceForTests();
});

it('deletes a landed batch on the next quit after timeout, cancellation, and deleting the last note', async () => {
  vi.useFakeTimers();
  const adapter = new FakePtyAdapter();
  setPlatform(adapter);
  const noteId = addPlainNote('pane-a', 'original');
  const port = adapter.notepadArchive;
  const save = port.save.bind(port);
  let release!: () => void;
  const reply = new Promise<void>((resolve) => { release = resolve; });
  vi.spyOn(port, 'save').mockImplementationOnce(async (archive, revision) => {
    const result = await save(archive, revision);
    await reply;
    return result;
  });
  const attempt = archiveNotesBeforeQuit();
  const timedOut = expect(attempt).rejects.toThrow('3s');
  await vi.advanceTimersByTimeAsync(3000);
  await timedOut;
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(getNotes('pane-a')).toHaveLength(1);

  // The user cancelled quit and then removed everything the timed-out save kept.
  deleteNote('pane-a', noteId!);
  expect(getNotepadSnapshot().size).toBe(0);
  await archiveNotesBeforeQuit();
  expect((await port.load())?.raw).toEqual({ version: 1, batches: [] });
});
