// The archive store as plain memory: the website demo's entire implementation,
// the standalone browser-dev harness's stand-in for the Tauri file, and what
// `FakePtyAdapter` hands tests and stories. It honors the same
// compare-and-swap contract as the real hosts, so a conflict exercised here is
// the same retry loop the file and `globalState` hosts drive
// (docs/specs/notepad.md).
import type {
  NotepadArchiveLoadResult,
  NotepadArchivePort,
  NotepadArchiveV1,
  VolatileNotepadSnapshot,
} from './types';

export interface MemoryNotepadArchivePort extends NotepadArchivePort {
  /** Install stored data without going through `save` — the seam tests,
   *  stories, and the dev harness use to start from a populated archive. */
  seed(archive: NotepadArchiveV1): void;
  /** Store something `readNotepadArchive` rejects, so the unreadable path can
   *  be exercised without hand-writing a corrupt file. */
  corrupt(raw?: unknown): void;
  /** Copies moved aside by `resetUnreadable`, newest last. Nothing this port
   *  holds is ever destroyed by recovery. */
  unreadableCopies(): readonly unknown[];
  /** The last mirror `syncVolatile` received; `null` until one arrives. */
  lastVolatileSnapshot(): VolatileNotepadSnapshot | null;
  /** Forget everything, including the set-aside copies (test teardown). */
  clear(): void;
}

/** Stored data is JSON on every real host, so the memory port round-trips it
 *  too: a caller that mutates the archive it saved must not reach back into
 *  the store. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createMemoryNotepadArchivePort(): MemoryNotepadArchivePort {
  // `undefined` is "nothing has ever been archived" (a `null` load); any other
  // value is stored bytes, valid or not — validation is the shared layer's job.
  let stored: unknown | undefined;
  let revision = 0;
  const setAside: unknown[] = [];
  let volatileSnapshot: VolatileNotepadSnapshot | null = null;

  const revisionToken = (): string | null => (stored === undefined ? null : String(revision));

  return {
    async load(): Promise<NotepadArchiveLoadResult | null> {
      const token = revisionToken();
      return token === null ? null : { raw: stored, revision: token };
    },
    async save(archive: NotepadArchiveV1, baseRevision: string | null): Promise<'ok' | 'conflict'> {
      if (baseRevision !== revisionToken()) return 'conflict';
      stored = clone(archive);
      revision += 1;
      return 'ok';
    },
    async resetUnreadable(): Promise<void> {
      if (stored !== undefined) setAside.push(stored);
      stored = undefined;
      revision += 1;
    },
    syncVolatile(snapshot: VolatileNotepadSnapshot): void {
      volatileSnapshot = snapshot;
    },
    seed(archive: NotepadArchiveV1): void {
      stored = clone(archive);
      revision += 1;
    },
    corrupt(raw: unknown = '{ not an archive'): void {
      stored = raw;
      revision += 1;
    },
    unreadableCopies(): readonly unknown[] {
      return setAside;
    },
    lastVolatileSnapshot(): VolatileNotepadSnapshot | null {
      return volatileSnapshot;
    },
    clear(): void {
      stored = undefined;
      revision += 1;
      setAside.length = 0;
      volatileSnapshot = null;
    },
  };
}
