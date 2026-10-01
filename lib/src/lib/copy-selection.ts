import { writeTextToClipboard } from './clipboard';
import { editorRendering, nudgeCopyEdge } from './copy-editor';
import { flashCopy, getMouseSelectionState } from './mouse-selection';
import { getTerminalInstance } from './terminal-registry';

/**
 * Copy what the editor shows and confirm it with the flash. Lives apart from
 * `clipboard.ts` so it can reach `flashCopy` without that module depending on
 * the selection store's render side.
 *
 * The flash is withheld unless the clipboard write succeeded *and* the
 * selection is still the one that was copied — an await gives a new drag time
 * to land, and flashing then would clear the newer selection.
 */
export async function copySelection(terminalId: string): Promise<void> {
  const { selection, copyEditor } = getMouseSelectionState(terminalId);
  const terminal = getTerminalInstance(terminalId);
  if (!selection || !copyEditor || !terminal) return;
  const copied = await writeTextToClipboard(editorRendering(terminal, selection, copyEditor).text);
  if (copied && getMouseSelectionState(terminalId).selection === selection) flashCopy(terminalId, copyEditor.format);
}

/** Move a selection edge a word (`nudgeCopyEdge`). */
export function nudgeSelection(terminalId: string, edge: 'start' | 'end', dir: 1 | -1): void {
  const terminal = getTerminalInstance(terminalId);
  if (terminal) nudgeCopyEdge(terminalId, terminal, edge, dir);
}
