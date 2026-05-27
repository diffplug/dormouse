// Reading the typed command region of the cursor's logical line from the
// rendered terminal buffer. At submit time this is the `prompt + command` line;
// terminal-prompt-shape.ts strips the prompt off the front. We read from the
// logical start up to the live cursor column — not the end of the line — so a
// zsh-autosuggestions ghost suggestion (dim text rendered after the cursor) is
// excluded. Reading at submit keeps it timing-independent (unlike capturing a
// prompt-boundary anchor on the first keystroke, which races shell output).

/** Minimal slice of an xterm.js `IBufferLine`, kept tiny so this is unit-testable. */
export interface BufferLineLike {
  readonly isWrapped: boolean;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

/** Minimal slice of an xterm.js `IBuffer`. */
export interface BufferLike {
  getLine(index: number): BufferLineLike | undefined;
}

// Read the logical line containing the cursor up to `cursorCol`. `cursorAbsRow`
// is an absolute row (`baseY + cursorY`). Walks up through soft-wrapped rows to
// the line's start, then concatenates forward to the cursor, bounding the final
// row at the cursor column so anything to its right (autosuggest ghost text) is
// dropped.
export function readLogicalLineFromBuffer(
  buffer: BufferLike,
  cursorAbsRow: number,
  cursorCol: number,
): string | null {
  let start = cursorAbsRow;
  while (start > 0) {
    const line = buffer.getLine(start);
    if (!line || !line.isWrapped) break;
    start -= 1;
  }

  if (!buffer.getLine(start)) return null;

  let text = '';
  for (let row = start; row <= cursorAbsRow; row += 1) {
    const line = buffer.getLine(row);
    if (!line) break;
    const endColumn = row === cursorAbsRow ? cursorCol : undefined;
    text += line.translateToString(false, 0, endColumn);
  }
  return text;
}
