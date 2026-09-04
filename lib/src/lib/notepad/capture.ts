// "Add to notepad" for a finalized terminal selection (docs/specs/notepad.md →
// Capture). Body lands with the capture work; the signature is fixed here so
// the UI can be wired against it in parallel.

/** Capture the terminal's finalized selection into its notepad as a rich note,
 *  with a source pin when the normal buffer is active. Returns `false` when
 *  there is no finalized selection or no live terminal to read. */
export function addSelectionToNotepad(_terminalId: string): boolean {
  return false;
}
