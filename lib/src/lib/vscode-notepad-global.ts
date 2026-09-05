/**
 * The boot global carrying the VS Code extension host's volatile notepad mirror
 * into a *live resume* — a webview re-resolved over PTYs the extension host
 * still owns (`docs/specs/notepad.md` → Archive and Lifecycle).
 *
 * The name and the read live here, together, for the same reason
 * `vscode-recovery-global.ts` does it: the writer
 * (`vscode-ext/src/webview-html.ts`) and the reader
 * (`lib/src/lib/platform/vscode-adapter.ts`) sit in different packages, and a
 * string duplicated across that boundary fails *silently* — nothing errors, the
 * notes simply never come back. Sharing the constant makes a mismatch a compile
 * error instead.
 */
import { SURFACE_KINDS, type SurfaceKind } from 'dor/commands/types';
import { readArchivedNote, readCwdState } from './notepad/archive-model';
import type { ArchivedNote, VolatileNotepadSnapshot, VolatileSurfaceNotes } from './notepad/types';

/** Global the host injects the mirror into; `null` on every other boot. */
export const NOTEPAD_VOLATILE_GLOBAL = '__DORMOUSE_NOTEPAD_VOLATILE__';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readSurface(value: unknown): VolatileSurfaceNotes | null {
  if (!isRecord(value)) return null;
  if (typeof value.surfaceId !== 'string' || !value.surfaceId) return null;
  if (typeof value.surfaceTitle !== 'string') return null;
  if (typeof value.surfaceKind !== 'string' || !SURFACE_KINDS.includes(value.surfaceKind as SurfaceKind)) return null;
  if (!Array.isArray(value.notes)) return null;
  const notes: ArchivedNote[] = [];
  for (const raw of value.notes) {
    const note = readArchivedNote(raw);
    // One bad note drops the whole Surface: these go into the live store and
    // from there into the archive, so a half-read notepad would silently lose
    // notes rather than fail to restore them.
    if (!note) return null;
    notes.push(note);
  }
  return {
    surfaceId: value.surfaceId,
    surfaceTitle: value.surfaceTitle,
    surfaceKind: value.surfaceKind as SurfaceKind,
    // A CWD that does not read back is dropped, not fatal — it is metadata for
    // a batch this Surface has not written yet.
    cwd: readCwdState(value.cwd),
    notes,
  };
}

function readIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

function readNoteRefs(value: unknown): Array<{ batchId: string; noteId: string }> {
  if (!Array.isArray(value)) return [];
  const refs: Array<{ batchId: string; noteId: string }> = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    if (typeof entry.batchId !== 'string' || typeof entry.noteId !== 'string') continue;
    refs.push({ batchId: entry.batchId, noteId: entry.noteId });
  }
  return refs;
}

/**
 * Read the injected mirror, or `null` when this boot is not a live resume.
 *
 * Validated rather than trusted, like the recovery commands: the host wrote it,
 * but the notes reach the live notepad store and from there the archive, so a
 * payload that does not fit degrades to "no mirror" rather than to entries
 * nobody checked. It runs the archive validator's own readers rather than a
 * second copy of the schema — one bad note drops its Surface whole.
 */
export function readInjectedVolatileNotepad(): VolatileNotepadSnapshot | null {
  const raw = (globalThis as unknown as Record<string, unknown>)[NOTEPAD_VOLATILE_GLOBAL];
  if (!isRecord(raw) || !Array.isArray(raw.surfaces)) return null;
  const surfaces: VolatileSurfaceNotes[] = [];
  for (const entry of raw.surfaces) {
    const surface = readSurface(entry);
    if (surface) surfaces.push(surface);
  }
  const staged = isRecord(raw.stagedDeletions) ? raw.stagedDeletions : {};
  return {
    surfaces,
    stagedDeletions: {
      deleteBatchIds: readIdList(staged.deleteBatchIds),
      deleteNotes: readNoteRefs(staged.deleteNotes),
    },
  };
}
