// The renderer's live notes, keyed by Surface id, with a
// `useSyncExternalStore`-compatible subscription API. Notes live here and
// nowhere else: they are never written to a session snapshot, Lath persistence,
// `localStorage`, or webview state. The one mirror is `syncVolatile`, host
// memory that exists so a VS Code webview re-resolved over live PTYs can get its
// notes back (docs/specs/notepad.md).
import { hasTerminal, type SurfaceKind } from 'dor/commands/types';
import { getPlatformOrNull } from '../platform';
import type { CwdState } from '../terminal-state';
import { toArchivedNote } from './archive-model';
import type {
  LiveNote,
  NotepadArchiveMutation,
  NotepadArchivePort,
  RichTextRun,
  RuntimeTerminalSource,
  VolatileNotepadSnapshot,
  VolatileSurfaceNotes,
} from './types';

/** What the volatile mirror needs about a Surface that the notes themselves do
 *  not carry. The Wall owns this; see `setNotepadSurfaceMetaResolver`. */
export interface NotepadSurfaceMeta {
  surfaceTitle: string;
  surfaceKind: SurfaceKind;
  cwd: CwdState | null;
}

export type NotepadSurfaceMetaResolver = (surfaceId: string) => NotepadSurfaceMeta | null;

/** Shared identity for "this Surface has no notes", so `getNotes` stays stable
 *  for the (common) empty case instead of handing React a new array each render. */
const NO_NOTES: readonly LiveNote[] = Object.freeze([]);

const notesBySurface = new Map<string, LiveNote[]>();
const listeners = new Set<() => void>();
let cachedSnapshot: Map<string, LiveNote[]> | null = null;

/**
 * Surfaces whose notes a closure has snapshotted and not yet finished writing
 * (docs/specs/notepad.md → "Closure"). Counted, not flagged: two closures of one
 * Surface can overlap, and the second finishing must not thaw the notes the
 * first is still writing.
 */
const closingSurfaces = new Map<string, number>();

/**
 * The archive batch id each Surface's closure is using, remembered across that
 * Surface's attempts and forgotten once one lands (docs/specs/notepad.md →
 * "Model"). An attempt that reached the host and *then* reported failure has to
 * be replaceable by the next one, which is only addressable by id.
 */
const pendingBatchIdBySurface = new Map<string, string>();

/** The freeze's own listeners. It changes neither a note nor which panel is
 *  open, so waking `listeners` for it would drop the snapshot, re-render every
 *  Door, and post a volatile mirror that has not moved. */
const closingListeners = new Set<() => void>();

function notify(): void {
  cachedSnapshot = null;
  listeners.forEach((listener) => listener());
  scheduleVolatileSync();
}

function notifyClosing(): void {
  closingListeners.forEach((listener) => listener());
}

export function subscribeToNotepad(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Subscribe to the freeze alone (`isSurfaceClosing`), which is what the panel's
 *  read-only state reads. */
export function subscribeToClosing(listener: () => void): () => void {
  closingListeners.add(listener);
  return () => {
    closingListeners.delete(listener);
  };
}

/** Stable snapshot reference (changes only on mutation) for `useSyncExternalStore`. */
export function getNotepadSnapshot(): Map<string, LiveNote[]> {
  if (cachedSnapshot) return cachedSnapshot;
  cachedSnapshot = new Map(notesBySurface);
  return cachedSnapshot;
}

export function getNotes(surfaceId: string): readonly LiveNote[] {
  return notesBySurface.get(surfaceId) ?? NO_NOTES;
}

export function noteCount(surfaceId: string): number {
  return notesBySurface.get(surfaceId)?.length ?? 0;
}

/** Whether a closure is holding this Surface's notes mid-write. Every content
 *  mutation below refuses while it is true, and the panel goes read-only. */
export function isSurfaceClosing(surfaceId: string): boolean {
  return closingSurfaces.has(surfaceId);
}

/** The batch id this Surface's closure appends under, minted on the first
 *  attempt and handed back unchanged to every retry, so a retry deletes and
 *  re-appends the batch an earlier attempt may already have landed. */
export function pendingBatchId(surfaceId: string): string {
  const remembered = pendingBatchIdBySurface.get(surfaceId);
  if (remembered) return remembered;
  const minted = newNotepadId('batch');
  pendingBatchIdBySurface.set(surfaceId, minted);
  scheduleVolatileSync();
  return minted;
}

/** The id this Surface's closure is already holding, or `undefined` — the
 *  non-minting read. A closure with nothing left to append asks through here:
 *  minting one there would append a batch id nobody ever stored. */
export function peekPendingBatchId(surfaceId: string): string | undefined {
  return pendingBatchIdBySurface.get(surfaceId);
}

/**
 * Freeze these Surfaces' notes and hand back the release. The close coordinator
 * calls this before it reads a single note, so the batches it builds and the
 * notes nobody can touch are the same set; the release runs whether the write
 * lands or rejects.
 */
export function beginClosing(surfaceIds: Iterable<string>): () => void {
  const ids = [...surfaceIds];
  for (const id of ids) closingSurfaces.set(id, (closingSurfaces.get(id) ?? 0) + 1);
  if (ids.length > 0) notifyClosing();
  let released = false;
  return () => {
    // Idempotent: a caller that releases twice must not thaw someone else's
    // overlapping closure.
    if (released) return;
    released = true;
    for (const id of ids) {
      const remaining = (closingSurfaces.get(id) ?? 1) - 1;
      if (remaining <= 0) closingSurfaces.delete(id);
      else closingSurfaces.set(id, remaining);
    }
    if (ids.length > 0) notifyClosing();
  };
}

let idCounter = 0;

/** `crypto.randomUUID` everywhere it exists; the counter is for the odd
 *  environment (an insecure origin, an older runtime) where it does not, since
 *  a note or batch with no id cannot be addressed for edit, delete, or archive.
 *  Shared with the close coordinator so notes and archive batches mint ids the
 *  same way; `prefix` only labels the fallback form. */
export function newNotepadId(prefix = 'note'): string {
  const webCrypto = globalThis.crypto as Crypto | undefined;
  if (webCrypto && typeof webCrypto.randomUUID === 'function') return webCrypto.randomUUID();
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

function replaceNotes(surfaceId: string, next: LiveNote[]): void {
  if (next.length === 0) notesBySurface.delete(surfaceId);
  else notesBySurface.set(surfaceId, next);
  notify();
}

function appendNote(surfaceId: string, note: LiveNote): string {
  replaceNotes(surfaceId, [...(notesBySurface.get(surfaceId) ?? []), note]);
  return note.id;
}

/** Add an empty (or pre-filled) plain note at the bottom. The panel focuses it;
 *  an untouched one is removed again by `pruneEmptyNote`. `null` while the
 *  Surface is closing — the note would be dropped unarchived, and the caller
 *  must not go looking for it. */
export function addPlainNote(surfaceId: string, text = ''): string | null {
  if (isSurfaceClosing(surfaceId)) return null;
  return appendNote(surfaceId, {
    id: newNotepadId(),
    createdAt: Date.now(),
    content: { kind: 'plain', text },
  });
}

/** Add a captured terminal selection. `source` is present only for
 *  normal-buffer captures — it is what a pin resolves against. `null` while the
 *  Surface is closing, the markers released here because no note will own them. */
export function addTerminalNote(
  surfaceId: string,
  runs: RichTextRun[],
  source?: RuntimeTerminalSource,
): string | null {
  if (isSurfaceClosing(surfaceId)) {
    source?.startMarker.dispose();
    source?.endMarker.dispose();
    return null;
  }
  const note: LiveNote = {
    id: newNotepadId(),
    createdAt: Date.now(),
    content: { kind: 'terminal', runs },
  };
  if (source) note.source = source;
  return appendNote(surfaceId, note);
}

/**
 * The one path that changes note text, and therefore the one place a rich note
 * becomes plain. Conversion and the edit are a single transition: a caret moving
 * through a rich note, or a read of its runs, changes nothing.
 *
 * The source link survives the conversion — it points at where the text came
 * from, which an edit does not move.
 */
export function setNoteText(surfaceId: string, noteId: string, text: string): void {
  // An edit landing mid-write would archive the pre-edit text and then be
  // forgotten with the rest of the notepad.
  if (isSurfaceClosing(surfaceId)) return;
  const current = notesBySurface.get(surfaceId);
  if (!current) return;
  const index = current.findIndex((note) => note.id === noteId);
  if (index === -1) return;
  const note = current[index];
  if (note.content.kind === 'plain' && note.content.text === text) return;
  const next = current.slice();
  next[index] = { ...note, content: { kind: 'plain', text } };
  replaceNotes(surfaceId, next);
}

function disposeSource(note: LiveNote): void {
  if (!note.source) return;
  note.source.startMarker.dispose();
  note.source.endMarker.dispose();
}

/** The note without its pin, markers released. The one shape of "this link can
 *  never resolve again": a failed reveal, the terminal going away, and an
 *  in-place replacement all end here. */
function withoutSource(note: LiveNote): LiveNote {
  disposeSource(note);
  const { source: _dropped, ...rest } = note;
  return rest;
}

export function deleteNote(surfaceId: string, noteId: string): void {
  if (isSurfaceClosing(surfaceId)) return;
  const current = notesBySurface.get(surfaceId);
  if (!current) return;
  const note = current.find((candidate) => candidate.id === noteId);
  if (!note) return;
  // The markers exist only to serve this note's pin; nothing else can reach
  // them once it is gone.
  disposeSource(note);
  replaceNotes(
    surfaceId,
    current.filter((candidate) => candidate.id !== noteId),
  );
}

/** An untouched Add New. Not a note the user wrote: it is pruned on blur, and a
 *  closure never archives it — it would be a row nobody typed, and a Surface
 *  holding only these closes as if it held none. */
export function isEmptyPlainNote(note: LiveNote): boolean {
  return note.content.kind === 'plain' && note.content.text === '';
}

/**
 * Remove a note only if it is plain and empty — the blur/close rule for an
 * Add New that was never typed into. A rich note or one with text is kept, so
 * this is safe to call on every blur.
 */
export function pruneEmptyNote(surfaceId: string, noteId: string): boolean {
  if (isSurfaceClosing(surfaceId)) return false;
  const note = notesBySurface.get(surfaceId)?.find((candidate) => candidate.id === noteId);
  if (!note) return false;
  if (!isEmptyPlainNote(note)) return false;
  deleteNote(surfaceId, noteId);
  return true;
}

/** Drop one note's source link: the pin disappears, the note stays. Called when
 *  a pin fails to resolve (disposed markers, trimmed scrollback, text mismatch). */
export function dropSource(surfaceId: string, noteId: string): void {
  if (isSurfaceClosing(surfaceId)) return;
  const current = notesBySurface.get(surfaceId);
  if (!current) return;
  const index = current.findIndex((note) => note.id === noteId);
  if (index === -1) return;
  const note = current[index];
  if (!note.source) return;
  const next = current.slice();
  next[index] = withoutSource(note);
  replaceNotes(surfaceId, next);
}

/**
 * Drop every pin pointing at a terminal that is being disposed, across all
 * Surfaces. Markers belong to one xterm instance, so replacing or killing that
 * instance invalidates them immediately; the notes themselves are untouched.
 */
export function dropSourcesForTerminal(terminalId: string): void {
  let changed = false;
  for (const [surfaceId, current] of notesBySurface) {
    if (!current.some((note) => note.source?.terminalId === terminalId)) continue;
    const next = current.map((note) => (
      note.source?.terminalId === terminalId ? withoutSource(note) : note
    ));
    notesBySurface.set(surfaceId, next);
    changed = true;
  }
  if (changed) notify();
}

/**
 * Follow an in-place replacement (renderer swap, browser/terminal mode change,
 * untouched-shell replace) to the new Surface id it mints. The notes move as
 * they are; pins into the *old* terminal go, because that instance is being
 * disposed as part of the replacement.
 */
export function transferNotepad(oldId: string, newId: string): void {
  if (oldId === newId) return;
  // Either end frozen means a closure is holding one of these notepads: moving
  // notes out from under it would archive a batch for a Surface id that no
  // longer owns them.
  if (isSurfaceClosing(oldId) || isSurfaceClosing(newId)) return;
  // Both before the empty-notepad early return: the old id stops existing either
  // way, so an open panel pointing at it would be stranded on a Surface that is
  // gone, and a pending batch id left behind could never be replaced.
  if (openNotepadId === oldId) setOpenNotepadId(newId);
  const pending = pendingBatchIdBySurface.get(oldId);
  if (pending !== undefined) {
    pendingBatchIdBySurface.set(newId, pending);
    pendingBatchIdBySurface.delete(oldId);
  }
  const moving = notesBySurface.get(oldId);
  if (!moving || moving.length === 0) return;
  const carried = moving.map((note) => (
    note.source?.terminalId === oldId ? withoutSource(note) : note
  ));
  notesBySurface.delete(oldId);
  notesBySurface.set(newId, [...(notesBySurface.get(newId) ?? []), ...carried]);
  notify();
}

/** Forget a Surface's notes (it closed; anything worth keeping was archived
 *  before teardown). */
export function removeSurface(surfaceId: string): void {
  // The closure is over: whatever batch id it was holding has landed, and the
  // next closure of this id is a new batch rather than a replacement.
  pendingBatchIdBySurface.delete(surfaceId);
  const current = notesBySurface.get(surfaceId);
  if (!current) {
    if (openNotepadId === surfaceId) setOpenNotepadId(null);
    return;
  }
  current.forEach(disposeSource);
  notesBySurface.delete(surfaceId);
  if (openNotepadId === surfaceId) setOpenNotepadId(null);
  notify();
}

/** Tests and Storybook: module state outlives components. */
export function clearAllNotepads(): void {
  for (const notes of notesBySurface.values()) notes.forEach(disposeSource);
  notesBySurface.clear();
  closingSurfaces.clear();
  pendingBatchIdBySurface.clear();
  metaResolver = null;
  stagedDeletions = {};
  setOpenNotepadId(null);
  notify();
  notifyClosing();
}

// --- Open panel ---
//
// Only one Surface notepad is open per Wall, so this is a single id rather than
// per-Surface open state. Its own listener set: a note edit must not re-render
// every header that only cares about which panel is open, and vice versa.

let openNotepadId: string | null = null;
const openListeners = new Set<() => void>();

export function subscribeToOpenNotepad(listener: () => void): () => void {
  openListeners.add(listener);
  return () => {
    openListeners.delete(listener);
  };
}

export function getOpenNotepadId(): string | null {
  return openNotepadId;
}

export function setOpenNotepadId(surfaceId: string | null): void {
  if (openNotepadId === surfaceId) return;
  openNotepadId = surfaceId;
  openListeners.forEach((listener) => listener());
}

// --- Volatile mirror ---

let metaResolver: NotepadSurfaceMetaResolver | null = null;
let stagedDeletions: Pick<NotepadArchiveMutation, 'deleteBatchIds' | 'deleteNotes'> = {};

/** The Wall installs this; until it does, the mirror carries empty metadata
 *  rather than nothing, so notes still survive a live resume. */
export function setNotepadSurfaceMetaResolver(resolver: NotepadSurfaceMetaResolver | null): void {
  metaResolver = resolver;
  scheduleVolatileSync();
}

/** One Surface's metadata as the Wall sees it right now, or `null` when no
 *  resolver is installed. The volatile mirror and the close coordinator both
 *  read through here, so a mirrored batch and an archived one describe the
 *  Surface identically (docs/specs/notepad.md → "Closure"). */
export function getNotepadSurfaceMeta(surfaceId: string): NotepadSurfaceMeta | null {
  return metaResolver?.(surfaceId) ?? null;
}

/** Archive deletions staged in an open Archive view, mirrored so a host that
 *  loses the webview can still commit them. */
export function setStagedArchiveDeletions(
  deletions: Pick<NotepadArchiveMutation, 'deleteBatchIds' | 'deleteNotes'>,
): void {
  stagedDeletions = deletions;
  scheduleVolatileSync();
}

/** No platform installed yet simply means no mirror. */
function archivePort(): NotepadArchivePort | undefined {
  return getPlatformOrNull()?.notepadArchive;
}

/** Surfaces whose next closure must append notes or replace a possibly landed batch. */
export function notepadSurfaceIds(): string[] {
  return [...new Set([...notesBySurface.keys(), ...pendingBatchIdBySurface.keys()])];
}

/** Everything a close would archive for every Surface holding notes, minus the
 *  markers (`toArchivedNote` strips them). */
export function buildVolatileSnapshot(): VolatileNotepadSnapshot {
  const surfaces: VolatileSurfaceNotes[] = [];
  for (const surfaceId of notepadSurfaceIds()) {
    const notes = getNotes(surfaceId);
    const pendingBatchId = pendingBatchIdBySurface.get(surfaceId);
    const meta = getNotepadSurfaceMeta(surfaceId);
    surfaces.push({
      surfaceId,
      surfaceTitle: meta?.surfaceTitle ?? '',
      surfaceKind: meta?.surfaceKind ?? 'terminal',
      cwd: meta?.cwd ?? null,
      // Only a terminal Surface has a PTY to ask about; its Surface id is
      // also its PTY id, so the mirror carries it straight through
      // (docs/specs/notepad.md → "VS Code lifecycle").
      ...(meta && hasTerminal(meta.surfaceKind)
        ? { terminalId: surfaceId }
        : {}),
      ...(pendingBatchId ? { pendingBatchId } : {}),
      notes: notes.map(toArchivedNote),
    });
  }
  return { surfaces, stagedDeletions };
}

let syncScheduled = false;

/** One snapshot per burst: typing a line of text is one keystroke per change,
 *  and the mirror only has to be right by the time control returns to the host. */
function scheduleVolatileSync(): void {
  if (syncScheduled) return;
  syncScheduled = true;
  queueMicrotask(() => {
    syncScheduled = false;
    const port = archivePort();
    if (!port?.syncVolatile) return;
    port.syncVolatile(buildVolatileSnapshot());
  });
}

/**
 * Restore mirrored notes on a live resume — a webview re-resolved over PTYs the
 * host still owns. Only ids in `liveSurfaceIds` are restored, and only into
 * Surfaces that have no notes yet, so this can never overwrite a live notepad
 * or resurrect notes for a Surface that is gone. Sources are not restored: the
 * markers died with the previous webview's xterm instances.
 *
 * `snapshot.stagedDeletions` is ignored by design. The disposal that produced
 * this resume committed them, so nothing there is still pending; re-staging them
 * would offer an Undo for deletions the archive has already taken
 * (`takeStagedForRouter` in `vscode-ext/src/notepad-volatile.ts`).
 */
export function hydrateNotepadFromVolatile(
  snapshot: VolatileNotepadSnapshot,
  liveSurfaceIds: Iterable<string>,
): void {
  const live = new Set(liveSurfaceIds);
  let changed = false;
  for (const surface of snapshot.surfaces) {
    if (!live.has(surface.surfaceId)) continue;
    if ((notesBySurface.get(surface.surfaceId)?.length ?? 0) > 0) continue;
    if (pendingBatchIdBySurface.has(surface.surfaceId)) continue;
    if (surface.pendingBatchId) {
      pendingBatchIdBySurface.set(surface.surfaceId, surface.pendingBatchId);
      changed = true;
    }
    if (surface.notes.length === 0) continue;
    notesBySurface.set(
      surface.surfaceId,
      surface.notes.map((note) => ({ id: note.id, createdAt: note.createdAt, content: note.content })),
    );
    changed = true;
  }
  if (changed) notify();
}
