// Following a note's source pin back to its scrollback (docs/specs/notepad.md
// → Source links). Every failure but an active alternate buffer is terminal for
// the pin: the markers are released and the link removed, so a pin the user can
// see is one that resolved the last time it was asked — or one waiting for a
// full-screen program to exit. The note itself is never touched.
import { getTerminalInstance } from '../terminal-registry';
import { dropSource, getNotes } from './notepad-store';
import { resolveTerminalSource, revealResolvedSource } from './source-link';

export type PinFailureReason =
  | 'no-source'
  | 'no-terminal'
  | 'alternate-buffer'
  | 'disposed'
  | 'missing-rows'
  | 'mismatch';

export type PinOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: PinFailureReason;
      /** Whether the pin survived — true only for `alternate-buffer`, the one
       *  failure that can resolve later. Everything downstream reads this
       *  rather than the reason: dropping the source, and the notice a row
       *  shows (`sourceNoticeFor` in `lib/src/components/NoteList.tsx`). */
      kept: boolean;
    };

/** The single place a failure reason decides whether the pin lives. */
function failed(reason: PinFailureReason): Extract<PinOutcome, { ok: false }> {
  return { ok: false, reason, kept: reason === 'alternate-buffer' };
}

/** Resolve the note's pin against the live buffer; on success scroll the range
 *  into view and restore the Dormouse selection (outline + finalized popup).
 *  On failure the reason is returned, and the pin removed from the note unless
 *  it can still resolve later. */
export function revealNoteSource(surfaceId: string, noteId: string): PinOutcome {
  // A missing note reads the same as a note without a pin: there is nothing to
  // follow and nothing to clean up.
  const source = getNotes(surfaceId).find((note) => note.id === noteId)?.source;
  if (!source) return failed('no-source');

  const terminal = getTerminalInstance(source.terminalId);
  if (!terminal) {
    // The instance the markers belong to is gone, so they can never resolve
    // again — `dropSource` disposes them on the way out.
    dropSource(surfaceId, noteId);
    return failed('no-terminal');
  }

  const resolved = resolveTerminalSource(terminal, source);
  if (!resolved.ok) {
    const outcome = failed(resolved.reason);
    // A full-screen program only covers the normal buffer the markers ride, so
    // that pin is temporarily unavailable rather than dead: keep it and let the
    // user try again once the program exits.
    if (!outcome.kept) dropSource(surfaceId, noteId);
    return outcome;
  }

  revealResolvedSource(source.terminalId, resolved.selection);
  return { ok: true };
}
