import { writeTextToClipboard } from './clipboard';
import { editorRendering } from './copy-editor';
import { flashCopy, getMouseSelectionState } from './mouse-selection';

/**
 * Copy what the editor shows and confirm it with the flash. Apart from
 * `copy-editor.ts` because `clipboard.ts` reaches the terminal registry barrel,
 * which imports the mouse router that opens the editor.
 *
 * The flash is withheld unless the clipboard write succeeded *and* the
 * selection is still the one that was copied — an await gives a new drag time
 * to land, and flashing then would clear the newer selection.
 */
export async function copySelection(terminalId: string): Promise<void> {
  const { selection, copyEditor, programCopy } = getMouseSelectionState(terminalId);
  if (!selection || !copyEditor) return;
  const copied = await writeTextToClipboard(editorRendering(copyEditor, programCopy).text);
  if (copied && getMouseSelectionState(terminalId).selection === selection) flashCopy(terminalId, copyEditor.format);
}
