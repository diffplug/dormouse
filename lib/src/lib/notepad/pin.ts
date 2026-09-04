// Following a note's source pin back to its scrollback (docs/specs/notepad.md
// → Source links). Every failure is terminal for the pin: the markers are
// released and the link removed, so a pin the user can see is one that resolved
// the last time it was asked. The note itself is never touched.
import { getTerminalInstance } from '../terminal-registry';
import { dropSource, getNotes } from './notepad-store';
import { resolveTerminalSource, revealResolvedSource } from './source-link';

export type PinOutcome =
  | { ok: true }
  | { ok: false; reason: 'no-source' | 'no-terminal' | 'disposed' | 'missing-rows' | 'mismatch' };

/** Resolve the note's pin against the live buffer; on success scroll the range
 *  into view and restore the Dormouse selection (outline + finalized popup).
 *  On any failure the pin is removed from the note and the reason returned. */
export function revealNoteSource(surfaceId: string, noteId: string): PinOutcome {
  // A missing note reads the same as a note without a pin: there is nothing to
  // follow and nothing to clean up.
  const source = getNotes(surfaceId).find((note) => note.id === noteId)?.source;
  if (!source) return { ok: false, reason: 'no-source' };

  const terminal = getTerminalInstance(source.terminalId);
  if (!terminal) {
    // The instance the markers belong to is gone, so they can never resolve
    // again — `dropSource` disposes them on the way out.
    dropSource(surfaceId, noteId);
    return { ok: false, reason: 'no-terminal' };
  }

  const resolved = resolveTerminalSource(terminal, source);
  if (!resolved.ok) {
    dropSource(surfaceId, noteId);
    return { ok: false, reason: resolved.reason };
  }

  revealResolvedSource(source.terminalId, resolved.selection);
  return { ok: true };
}
