// Following a note's source pin back to its scrollback (docs/specs/notepad.md
// → Source links). Validate before changing the view, then prove the displayed
// range again: opening Tool context can reflow a previously valid source. The
// note itself is never touched.
import { getTerminalInstance } from '../terminal-registry';
import { dropSource, getNotes } from './notepad-store';
import { resolveTerminalSource, revealResolvedSource } from './source-link';

export type PinFailureReason =
  | 'no-source'
  | 'no-terminal'
  | 'alternate-buffer'
  | 'layout-changed'
  | 'disposed'
  | 'missing-rows'
  | 'mismatch';

export type PinOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: PinFailureReason;
      /** Whether the pin survived. Covered sources and sources invalidated by
       *  this reveal's layout change are retained. */
      kept: boolean;
    };

/** The single place a failure reason decides whether the pin lives. */
function failed(reason: PinFailureReason): Extract<PinOutcome, { ok: false }> {
  return { ok: false, reason, kept: reason === 'alternate-buffer' || reason === 'layout-changed' };
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

  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('dormouse:reveal-note-source', { detail: { surfaceId, terminalId: source.terminalId } }));
  // Context mounts and refits synchronously during the event. Never select the
  // old coordinates or destroy a source that our own view change invalidated.
  const displayed = resolveTerminalSource(terminal, source);
  if (!displayed.ok) return failed('layout-changed');

  revealResolvedSource(source.terminalId, displayed.selection);
  return { ok: true };
}
