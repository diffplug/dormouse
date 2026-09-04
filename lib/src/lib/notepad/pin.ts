// Following a note's source pin back to its scrollback (docs/specs/notepad.md
// → Source links). Body lands with the capture work; the signature is fixed
// here so the UI can be wired against it in parallel.

export type PinOutcome =
  | { ok: true }
  | { ok: false; reason: 'no-source' | 'no-terminal' | 'disposed' | 'missing-rows' | 'mismatch' };

/** Resolve the note's pin against the live buffer; on success scroll the range
 *  into view and restore the Dormouse selection (outline + finalized popup).
 *  On any failure the pin is removed from the note and the reason returned. */
export function revealNoteSource(_surfaceId: string, _noteId: string): PinOutcome {
  return { ok: false, reason: 'no-source' };
}
