// What every notepad trigger needs from the store: the counts and open id the
// headers and Doors subscribe to, and the two strings/actions they share
// (docs/specs/notepad.md). Whether the host has a notepad at all is
// `hasNotepadArchive()` in `lib/src/lib/notepad/archive-service.ts`.
import { useCallback, useSyncExternalStore } from 'react';
import {
  getNotes,
  getOpenNotepadId,
  isSurfaceClosing,
  noteCount,
  subscribeToNotepad,
  subscribeToOpenNotepad,
} from '../lib/notepad/notepad-store';
import { copyNoteToClipboard } from '../lib/notepad/rich-clipboard';
import type { LiveNote } from '../lib/notepad/types';

/** A Surface's note count. A number rather than the notes themselves, so a
 *  header re-renders only when the count it draws actually moves. */
export function useNoteCount(surfaceId: string): number {
  return useSyncExternalStore(
    subscribeToNotepad,
    useCallback(() => noteCount(surfaceId), [surfaceId]),
  );
}

/** A Surface's notes. The store hands back a stable array per surface, so this
 *  is safe as a `useSyncExternalStore` snapshot. */
export function useNotes(surfaceId: string): readonly LiveNote[] {
  return useSyncExternalStore(
    subscribeToNotepad,
    useCallback(() => getNotes(surfaceId), [surfaceId]),
  );
}

/** Whether a closure is holding this Surface's notes mid-write, so the panel
 *  renders read-only (docs/specs/notepad.md → "Closure"). */
export function useSurfaceClosing(surfaceId: string): boolean {
  return useSyncExternalStore(
    subscribeToNotepad,
    useCallback(() => isSurfaceClosing(surfaceId), [surfaceId]),
  );
}

/** The one Surface whose notepad is open, Wall-wide. */
export function useOpenNotepadId(): string | null {
  return useSyncExternalStore(subscribeToOpenNotepad, getOpenNotepadId);
}

/** Accessible name and tooltip for the notepad triggers, count included so a
 *  filled icon says how filled it is. */
export function notepadLabel(count: number): string {
  if (count === 0) return 'Notepad';
  return `Notepad · ${count} ${count === 1 ? 'note' : 'notes'}`;
}

/** Fire-and-forget: the clipboard write is best effort by contract, and the
 *  Copy button's own check is the feedback. */
export function copyNote(note: LiveNote): void {
  void copyNoteToClipboard(note.content);
}
