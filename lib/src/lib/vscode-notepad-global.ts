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
import type { ArchivedNote, VolatileNotepadSnapshot, VolatileSurfaceNotes } from './notepad/types';
import type { CwdState } from './terminal-state';

/** Global the host injects the mirror into; `null` on every other boot. */
export const NOTEPAD_VOLATILE_GLOBAL = '__DORMOUSE_NOTEPAD_VOLATILE__';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readSurface(value: unknown): VolatileSurfaceNotes | null {
  if (!isRecord(value)) return null;
  if (typeof value.surfaceId !== 'string' || !value.surfaceId) return null;
  if (typeof value.surfaceTitle !== 'string' || typeof value.surfaceKind !== 'string') return null;
  if (!Array.isArray(value.notes)) return null;
  return {
    surfaceId: value.surfaceId,
    surfaceTitle: value.surfaceTitle,
    surfaceKind: value.surfaceKind as VolatileSurfaceNotes['surfaceKind'],
    cwd: isRecord(value.cwd) ? (value.cwd as unknown as CwdState) : null,
    notes: value.notes as ArchivedNote[],
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
 * Shape-checked rather than trusted, like the recovery commands: the host wrote
 * it, but the notes reach the live notepad store and from there the archive, so
 * a payload that does not fit degrades to "no mirror" rather than to entries
 * nobody validated. The deep validation is the host's — it only mirrors a
 * Surface whose archive batch reads back through `readNotepadArchive`
 * (`vscode-ext/src/notepad-volatile.ts`) — so this is the boundary check, not a
 * second copy of the schema.
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
