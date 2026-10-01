import { writeTextToClipboard } from './clipboard';
import { editorRendering } from './copy-editor';
import { COPY_FLASH_MS, failCopy, flashCopy, getMouseSelectionState, TOUCH_COPY_FLASH_MS } from './mouse-selection';

/**
 * Copy what the editor shows and confirm it with the flash, held longer on
 * touch, with a tap of vibration where the device has it. Apart from
 * `copy-editor.ts` because `clipboard.ts` reaches the terminal registry barrel,
 * which imports the mouse router that opens the editor.
 *
 * The flash is withheld unless the clipboard write succeeded *and* the
 * selection is still the one that was copied — an await gives a new drag time
 * to land, and flashing then would clear the newer selection. A failed write
 * says so instead, for that selection, and keeps it.
 */
export async function copySelection(terminalId: string, { touch = false }: { touch?: boolean } = {}): Promise<void> {
  const { selection, copyEditor, programCopy } = getMouseSelectionState(terminalId);
  if (!selection || !copyEditor) return;
  const copied = await writeTextToClipboard(editorRendering(copyEditor, programCopy).text);
  if (getMouseSelectionState(terminalId).selection !== selection) return;
  if (!copied) {
    failCopy(terminalId);
    return;
  }
  flashCopy(terminalId, touch ? TOUCH_COPY_FLASH_MS : COPY_FLASH_MS);
  if (touch) navigator.vibrate?.(10);
}
