// The one path between the UI and `getPlatform().notepadArchive`: a
// `useSyncExternalStore` store holding the loaded archive, and the
// read-modify-write that every mutation goes through
// (docs/specs/notepad.md → Archive).
//
// Hosts only store bytes and a revision, so the compare-and-swap lives here:
// load, validate, `applyArchiveMutation`, save against the revision we read,
// and on `'conflict'` do it again over whoever won. Mutations are idempotent by
// batch and note id, which is what makes that retry safe — a closure that
// already landed is re-applied as a no-op rather than a duplicate batch.
import { createSerialQueue } from '../../host/remote/serial-queue';
import { getPlatformOrNull } from '../platform';
import {
  applyArchiveMutation,
  EMPTY_ARCHIVE,
  isEmptyMutation,
  readNotepadArchive,
} from './archive-model';
import type { NotepadArchiveMutation, NotepadArchivePort, NotepadArchiveV1 } from './types';

export type NotepadArchiveStatus = 'absent' | 'loading' | 'ready' | 'unreadable' | 'error';

export interface NotepadArchiveState {
  /** `absent` = this host has no archive port at all (Pocket, or before a
   *  platform exists). `unreadable` = stored data that validation rejected; the
   *  archive below is empty but the stored bytes are untouched. */
  status: NotepadArchiveStatus;
  archive: NotepadArchiveV1;
  /** User-presentable; set for `unreadable` and `error`. */
  error?: string;
}

/** A save cannot win against an endlessly-rewritten archive, and an unbounded
 *  retry would spin instead of surfacing that. */
const MAX_SAVE_ATTEMPTS = 5;

export const ARCHIVE_ABSENT_MESSAGE = 'This host has no notepad archive.';
export const ARCHIVE_UNREADABLE_MESSAGE =
  'The notepad archive could not be read. Recover it from the Archive view to start a new one.';
export const ARCHIVE_BUSY_MESSAGE =
  'The notepad archive kept changing while saving. Try again.';

const INITIAL_STATE: NotepadArchiveState = { status: 'absent', archive: EMPTY_ARCHIVE };

let state: NotepadArchiveState = INITIAL_STATE;
const listeners = new Set<() => void>();

function setState(next: NotepadArchiveState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

export function subscribeToArchive(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable snapshot reference (changes only on mutation) for `useSyncExternalStore`. */
export function getArchiveSnapshot(): NotepadArchiveState {
  return state;
}

/** The host's port, or `undefined` when there is none — no platform installed
 *  yet reads the same as a host without a notepad. */
function archivePort(): NotepadArchivePort | undefined {
  return getPlatformOrNull()?.notepadArchive;
}

/** Whether this host has a notepad at all. Absent on Pocket, which hides the
 *  header icon, the Door button, the popup action, and the Settings entry with
 *  it. The one availability gate — every caller reads it. */
export function hasNotepadArchive(): boolean {
  return archivePort() !== undefined;
}

/** A rejection as something a user can read. Shared with the Archive view,
 *  which reports the same failures this module publishes. */
export function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

let inFlightLoad: Promise<void> | null = null;

async function runLoad(port: NotepadArchivePort): Promise<void> {
  setState({ status: 'loading', archive: state.archive });
  try {
    const loaded = await port.load();
    if (!loaded) {
      setState({ status: 'ready', archive: EMPTY_ARCHIVE });
      return;
    }
    const archive = readNotepadArchive(loaded.raw);
    if (!archive) {
      // Never replace it: the stored bytes stay exactly as they are until the
      // user asks for recovery (`resetUnreadableArchive`).
      setState({ status: 'unreadable', archive: EMPTY_ARCHIVE, error: ARCHIVE_UNREADABLE_MESSAGE });
      return;
    }
    setState({ status: 'ready', archive });
  } catch (error) {
    setState({ status: 'error', archive: state.archive, error: messageOf(error) });
  }
}

/** Re-read the stored archive unconditionally. Never rejects — a failed read is
 *  reported through the state so every subscriber sees the same thing. */
export function refreshArchive(): Promise<void> {
  const port = archivePort();
  if (!port) {
    setState({ status: 'absent', archive: EMPTY_ARCHIVE });
    return Promise.resolve();
  }
  const load = enqueue(() => runLoad(port));
  inFlightLoad = load;
  void load.then(() => {
    if (inFlightLoad === load) inFlightLoad = null;
  });
  return load;
}

/** Re-read on each Archive opening; simultaneous callers share the load. */
export function ensureArchiveLoaded(): Promise<void> {
  if (inFlightLoad) return inFlightLoad;
  return refreshArchive();
}

// One queue for every mutation. Two closing Surfaces would otherwise read the
// same revision and one would lose its batch to the other's conflict; serialized,
// the second reads what the first wrote.
let enqueue = createSerialQueue();

async function runMutation(port: NotepadArchivePort, mutation: NotepadArchiveMutation): Promise<void> {
  for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt++) {
    let loaded;
    try {
      loaded = await port.load();
    } catch (error) {
      setState({ status: 'error', archive: state.archive, error: messageOf(error) });
      throw error instanceof Error ? error : new Error(messageOf(error));
    }
    const base = loaded ? readNotepadArchive(loaded.raw) : EMPTY_ARCHIVE;
    if (!base) {
      setState({ status: 'unreadable', archive: EMPTY_ARCHIVE, error: ARCHIVE_UNREADABLE_MESSAGE });
      throw new Error(ARCHIVE_UNREADABLE_MESSAGE);
    }
    const next = applyArchiveMutation(base, mutation);
    let outcome: 'ok' | 'conflict';
    try {
      outcome = await port.save(next, loaded?.revision ?? null);
    } catch (error) {
      // The stored archive is whatever it was; publish the failure and leave
      // our copy alone rather than pretending the write landed.
      setState({ status: 'error', archive: state.archive, error: messageOf(error) });
      throw error instanceof Error ? error : new Error(messageOf(error));
    }
    if (outcome === 'ok') {
      setState({ status: 'ready', archive: next });
      return;
    }
    // Conflict: someone else wrote between our load and save. Re-read and
    // re-apply — idempotency makes the second pass land only what is missing.
  }
  setState({ status: 'error', archive: state.archive, error: ARCHIVE_BUSY_MESSAGE });
  throw new Error(ARCHIVE_BUSY_MESSAGE);
}

/**
 * Apply one mutation to the stored archive. Rejects with a user-presentable
 * message when the archive cannot be written — closure paths surface that as
 * "Keep open / Close anyway" rather than dropping the notes.
 */
export function mutateArchive(mutation: NotepadArchiveMutation): Promise<void> {
  // Nothing to write is not a reason to touch the host's store, and a closure
  // with no notes takes this path.
  if (isEmptyMutation(mutation)) return Promise.resolve();
  const port = archivePort();
  if (!port) {
    setState({ status: 'absent', archive: EMPTY_ARCHIVE });
    return Promise.reject(new Error(ARCHIVE_ABSENT_MESSAGE));
  }
  return enqueue(() => runMutation(port, mutation));
}

/**
 * Move unreadable stored data aside and start empty. The only path that
 * replaces an archive validation rejected, and only ever from an explicit user
 * action in the Archive view.
 */
export async function resetUnreadableArchive(): Promise<void> {
  const port = archivePort();
  if (!port) {
    setState({ status: 'absent', archive: EMPTY_ARCHIVE });
    throw new Error(ARCHIVE_ABSENT_MESSAGE);
  }
  await enqueue(async () => {
    try {
      await port.resetUnreadable();
    } catch (error) {
      setState({ status: 'error', archive: state.archive, error: messageOf(error) });
      throw error instanceof Error ? error : new Error(messageOf(error));
    }
  });
  await refreshArchive();
}

/** Test-only helper. Do not use in application code. */
export function __resetArchiveServiceForTests(): void {
  state = INITIAL_STATE;
  listeners.clear();
  inFlightLoad = null;
  enqueue = createSerialQueue();
}
