// "Add to notepad" for a finalized terminal selection (docs/specs/notepad.md →
// Capture). Reached from the selection popup's third button and from the
// Cmd/Ctrl+N chord, both of which flash and dismiss the selection themselves —
// a capture never opens the notepad.
import { getMouseSelectionState } from '../mouse-selection';
import { getPlatformOrNull } from '../platform';
import { getTerminalInstance } from '../terminal-registry';
import { hasNotepadArchive } from './archive-service';
import { addTerminalNote } from './notepad-store';
import { captureRichSelection } from './rich-extract';
import { registerTerminalSource } from './source-link';

/** Whether Cmd/Ctrl+N is ours to bind. The website demo runs in a browser that
 *  reserves the chord for a new window, so it keeps the button and shows no
 *  shortcut. */
export function isNotepadChordBound(): boolean {
  return hasNotepadArchive() && getPlatformOrNull()?.browserReservesNotepadChord !== true;
}

/** Capture the terminal's finalized selection into its notepad as a rich note,
 *  with a source pin when the normal buffer is active. Returns `false` when
 *  there is no finalized selection, no live terminal to read, or the Surface is
 *  closing — the caller flashes "Added" only on a `true`. */
export function addSelectionToNotepad(terminalId: string): boolean {
  const sel = getMouseSelectionState(terminalId).selection;
  // Mid-drag there is nothing settled to capture; the popup is not up either.
  if (!sel || sel.dragging) return false;
  const terminal = getTerminalInstance(terminalId);
  if (!terminal) return false;

  const { runs, rawText } = captureRichSelection(terminal, sel);
  // `null` on the alternate buffer — a full-screen program's grid is rewritten
  // in place, so the note simply carries no pin.
  const source = registerTerminalSource(terminal, terminalId, sel, rawText);
  // A terminal Surface's Surface id *is* its terminal id (docs/specs/layout.md →
  // "Session lifecycle"), so the note lands on the Surface holding the selection.
  // A closing Surface refuses it (and releases the markers) rather than take a
  // note its closure has already snapshotted past.
  return addTerminalNote(terminalId, runs, source ?? undefined) !== null;
}
