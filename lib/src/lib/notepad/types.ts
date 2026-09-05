// The notepad model (docs/specs/notepad.md). Bare TypeScript on purpose: the
// archive half is shared with the VS Code extension host, which applies
// mutations on the webview's behalf, so nothing here may reach for the DOM.
import type { IMarker } from '@xterm/xterm';
import type { SurfaceKind } from 'dor/commands/types';
import type { CwdState } from '../terminal-state';

/** One styled span of captured terminal text. Colors are normalized `#rrggbb`
 *  (lowercase); a missing color means the theme default, so a rich note stays
 *  theme-adaptive where the terminal was. Only these four attributes are kept —
 *  underline, dim, blink, strike-through, and hyperlinks are dropped at capture. */
export interface RichTextRun {
  text: string;
  bold?: true;
  italic?: true;
  foreground?: string;
  background?: string;
}

export type NoteContent =
  | { kind: 'plain'; text: string }
  | { kind: 'terminal'; runs: RichTextRun[] };

/** Runtime-only link from a captured note back to the scrollback it came from.
 *  Never serialized: markers belong to one live xterm instance. */
export interface RuntimeTerminalSource {
  terminalId: string;
  startMarker: IMarker;
  endMarker: IMarker;
  /** Normalized endpoint columns (start inclusive, end inclusive), so the range
   *  can be rebuilt from the markers' current lines. */
  startColumn: number;
  endColumn: number;
  shape: 'linewise' | 'block';
  /** `extractSelectionText` output at capture; a pin resolves only when the
   *  rebuilt range reads back exactly this. */
  expectedRawText: string;
}

export interface LiveNote {
  id: string;
  createdAt: number;
  content: NoteContent;
  source?: RuntimeTerminalSource;
}

export type ArchivedNote = Omit<LiveNote, 'source'>;

export interface ArchiveBatch {
  id: string;
  closedAt: number;
  surfaceTitle: string;
  surfaceKind: SurfaceKind;
  /** The Session's last known CWD at teardown, whole; `null` for browser
   *  Surfaces and terminals that never reported one. */
  cwd: CwdState | null;
  notes: ArchivedNote[];
}

export interface NotepadArchiveV1 {
  version: 1;
  batches: ArchiveBatch[];
}

/** Idempotent by batch and note id: appending a batch already present is a
 *  no-op, deleting something already gone is a no-op. Appends apply before
 *  deletes; a batch left with no notes is dropped. */
export interface NotepadArchiveMutation {
  append?: ArchiveBatch[];
  deleteBatchIds?: string[];
  deleteNotes?: Array<{ batchId: string; noteId: string }>;
}

/** What the VS Code extension host mirrors in memory for one live Surface:
 *  everything a close would archive, minus the markers. */
export interface VolatileSurfaceNotes {
  surfaceId: string;
  surfaceTitle: string;
  surfaceKind: SurfaceKind;
  cwd: CwdState | null;
  notes: ArchivedNote[];
}

export interface VolatileNotepadSnapshot {
  surfaces: VolatileSurfaceNotes[];
  /** Archive deletions staged in an open Archive view, committed by the host
   *  if the webview is disposed before the view closes. */
  stagedDeletions: Pick<NotepadArchiveMutation, 'deleteBatchIds' | 'deleteNotes'>;
}

export interface NotepadArchiveLoadResult {
  /** Whatever the host stored — validated by `readNotepadArchive`. */
  raw: unknown;
  /** Opaque token naming the stored version; `save` is refused when it moved. */
  revision: string;
}

/**
 * The host side of the archive. Hosts store bytes and a revision; the shared
 * layer (`archive-service.ts`) does the read-modify-write with
 * `applyArchiveMutation`, retrying on `'conflict'`. One store per host, never
 * shared across hosts (docs/specs/notepad.md).
 */
export interface NotepadArchivePort {
  /** `null` when nothing has ever been archived. */
  load(): Promise<NotepadArchiveLoadResult | null>;
  /** Replace the stored archive iff it is still at `baseRevision` (`null` =
   *  nothing stored). Atomic and owner-only on disk. */
  save(archive: NotepadArchiveV1, baseRevision: string | null): Promise<'ok' | 'conflict'>;
  /** User-initiated only: move unreadable stored data aside (never delete it)
   *  so the next `load` returns `null`. */
  resetUnreadable(): Promise<void>;
  /** Mirror live notes into host memory (VS Code). Never written to disk. */
  syncVolatile?(snapshot: VolatileNotepadSnapshot): void;
  /** The mirror a resumed webview was booted with, consumed by a live resume
   *  only — never by a cold restore. */
  loadVolatile?(): VolatileNotepadSnapshot | null;
}
