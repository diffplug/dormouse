// Pure archive logic shared by the webview and the VS Code extension host:
// validation of whatever a host hands back, the idempotent mutation, and the
// projection from live notes to an archive batch. No DOM, no xterm.
import { SURFACE_KINDS, type SurfaceKind } from 'dor/commands/types';
import type { CwdState, CwdSource, PathKind } from '../terminal-state';
import type {
  ArchiveBatch,
  ArchivedNote,
  LiveNote,
  NoteContent,
  NotepadArchiveMutation,
  NotepadArchiveV1,
  RichTextRun,
  VolatileSurfaceNotes,
} from './types';

export const EMPTY_ARCHIVE: NotepadArchiveV1 = Object.freeze({ version: 1, batches: [] }) as NotepadArchiveV1;

const HEX_COLOR = /^#[0-9a-f]{6}$/;
const CWD_SOURCES: readonly CwdSource[] = ['osc7', 'osc9_9', 'osc633', 'osc1337', 'process', 'manual'];
const PATH_KINDS: readonly PathKind[] = ['posix', 'windows', 'unknown'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readRun(value: unknown): RichTextRun | null {
  if (!isRecord(value) || typeof value.text !== 'string') return null;
  const run: RichTextRun = { text: value.text };
  if (value.bold !== undefined) {
    if (value.bold !== true) return null;
    run.bold = true;
  }
  if (value.italic !== undefined) {
    if (value.italic !== true) return null;
    run.italic = true;
  }
  for (const key of ['foreground', 'background'] as const) {
    const color = value[key];
    if (color === undefined) continue;
    if (typeof color !== 'string' || !HEX_COLOR.test(color)) return null;
    run[key] = color;
  }
  return run;
}

function readContent(value: unknown): NoteContent | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'plain') {
    return typeof value.text === 'string' ? { kind: 'plain', text: value.text } : null;
  }
  if (value.kind === 'terminal') {
    if (!Array.isArray(value.runs)) return null;
    const runs: RichTextRun[] = [];
    for (const raw of value.runs) {
      const run = readRun(raw);
      if (!run) return null;
      runs.push(run);
    }
    return { kind: 'terminal', runs };
  }
  return null;
}

function readNote(value: unknown): ArchivedNote | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || !value.id) return null;
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) return null;
  const content = readContent(value.content);
  if (!content) return null;
  return { id: value.id, createdAt: value.createdAt, content };
}

/** Accepts exactly the `CwdState` shape (`lib/src/lib/terminal-state.ts`):
 *  required `path`, `pathKind`, `isRemote`, `source`, `updatedAt`; optional
 *  `uri`, `host`, `scheme: 'file'`. */
export function readCwdState(value: unknown): CwdState | null {
  if (!isRecord(value)) return null;
  if (typeof value.path !== 'string') return null;
  if (typeof value.pathKind !== 'string' || !PATH_KINDS.includes(value.pathKind as PathKind)) return null;
  if (typeof value.isRemote !== 'boolean') return null;
  if (typeof value.source !== 'string' || !CWD_SOURCES.includes(value.source as CwdSource)) return null;
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return null;
  const cwd: CwdState = {
    path: value.path,
    pathKind: value.pathKind as PathKind,
    isRemote: value.isRemote,
    source: value.source as CwdSource,
    updatedAt: value.updatedAt,
  };
  if (value.uri !== undefined) {
    if (typeof value.uri !== 'string') return null;
    cwd.uri = value.uri;
  }
  if (value.host !== undefined) {
    if (typeof value.host !== 'string') return null;
    cwd.host = value.host;
  }
  if (value.scheme !== undefined) {
    if (value.scheme !== 'file') return null;
    cwd.scheme = 'file';
  }
  return cwd;
}

function readBatch(value: unknown): ArchiveBatch | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || !value.id) return null;
  if (typeof value.closedAt !== 'number' || !Number.isFinite(value.closedAt)) return null;
  if (typeof value.surfaceTitle !== 'string') return null;
  if (typeof value.surfaceKind !== 'string' || !SURFACE_KINDS.includes(value.surfaceKind as SurfaceKind)) return null;
  let cwd: CwdState | null = null;
  if (value.cwd !== null) {
    cwd = readCwdState(value.cwd);
    if (!cwd) return null;
  }
  if (!Array.isArray(value.notes)) return null;
  const notes: ArchivedNote[] = [];
  for (const raw of value.notes) {
    const note = readNote(raw);
    if (!note) return null;
    notes.push(note);
  }
  return {
    id: value.id,
    closedAt: value.closedAt,
    surfaceTitle: value.surfaceTitle,
    surfaceKind: value.surfaceKind as SurfaceKind,
    cwd,
    notes,
  };
}

/**
 * Validate a stored archive. Accepts the parsed object or its JSON string
 * (host state APIs may hand back the serialized form). Returns `null` for
 * anything that is not exactly a v1 archive — the caller reports it as
 * unreadable rather than replacing it (docs/specs/notepad.md → Archive).
 * Unknown fields are dropped by projection, so nothing foreign persists forward.
 */
export function readNotepadArchive(raw: unknown): NotepadArchiveV1 | null {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.batches)) return null;
  const batches: ArchiveBatch[] = [];
  const seen = new Set<string>();
  for (const rawBatch of value.batches) {
    const batch = readBatch(rawBatch);
    if (!batch || seen.has(batch.id)) return null;
    seen.add(batch.id);
    batches.push(batch);
  }
  return { version: 1, batches };
}

/** Apply a mutation immutably. Appends first (skipping batch ids already
 *  present), then batch deletes, then note deletes; batches emptied by note
 *  deletes are dropped. Applying the same mutation twice yields the same archive. */
export function applyArchiveMutation(archive: NotepadArchiveV1, mutation: NotepadArchiveMutation): NotepadArchiveV1 {
  const present = new Set(archive.batches.map((b) => b.id));
  let batches = archive.batches.slice();
  for (const batch of mutation.append ?? []) {
    if (present.has(batch.id)) continue;
    present.add(batch.id);
    batches.push(batch);
  }
  if (mutation.deleteBatchIds?.length) {
    const gone = new Set(mutation.deleteBatchIds);
    batches = batches.filter((b) => !gone.has(b.id));
  }
  if (mutation.deleteNotes?.length) {
    const goneByBatch = new Map<string, Set<string>>();
    for (const { batchId, noteId } of mutation.deleteNotes) {
      let set = goneByBatch.get(batchId);
      if (!set) {
        set = new Set();
        goneByBatch.set(batchId, set);
      }
      set.add(noteId);
    }
    batches = batches.flatMap((b) => {
      const gone = goneByBatch.get(b.id);
      if (!gone) return [b];
      const notes = b.notes.filter((n) => !gone.has(n.id));
      return notes.length === 0 ? [] : [{ ...b, notes }];
    });
  }
  return { version: 1, batches };
}

export function isEmptyMutation(mutation: NotepadArchiveMutation): boolean {
  return !mutation.append?.length && !mutation.deleteBatchIds?.length && !mutation.deleteNotes?.length;
}

/** Strip the runtime source link; the archive never carries markers. */
export function toArchivedNote(note: LiveNote): ArchivedNote {
  return { id: note.id, createdAt: note.createdAt, content: note.content };
}

/** The batch a closing Surface appends. `id` is minted once per closure and
 *  reused on retry, which is what makes the append idempotent. */
export function buildArchiveBatch(input: {
  id: string;
  closedAt: number;
  surfaceTitle: string;
  surfaceKind: SurfaceKind;
  cwd: CwdState | null;
  notes: ReadonlyArray<LiveNote | ArchivedNote>;
}): ArchiveBatch {
  return {
    id: input.id,
    closedAt: input.closedAt,
    surfaceTitle: input.surfaceTitle,
    surfaceKind: input.surfaceKind,
    cwd: input.cwd,
    notes: input.notes.map(toArchivedNote),
  };
}

/** The batch the VS Code host appends for a mirrored Surface it is tearing
 *  down (editor-panel disposal, deactivation). `null` when there is nothing
 *  to archive. */
export function batchFromVolatile(surface: VolatileSurfaceNotes, id: string, closedAt: number): ArchiveBatch | null {
  if (surface.notes.length === 0) return null;
  return buildArchiveBatch({
    id,
    closedAt,
    surfaceTitle: surface.surfaceTitle,
    surfaceKind: surface.surfaceKind,
    cwd: surface.cwd,
    notes: surface.notes,
  });
}
