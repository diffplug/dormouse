// Reading the cursor's full logical line from the rendered terminal buffer.
// At submit time this is the `prompt + command` line; terminal-prompt-shape.ts
// strips the prompt off the front. We read the whole logical line (joining any
// soft-wrapped continuation rows) rather than slicing at a captured cursor
// position, so it doesn't depend on catching the prompt at the right instant —
// which races shell output and history recall.

/** Minimal slice of an xterm.js `IBufferLine`, kept tiny so this is unit-testable. */
export interface BufferLineLike {
  readonly isWrapped: boolean;
  translateToString(trimRight?: boolean): string;
}

/** Minimal slice of an xterm.js `IBuffer`. */
export interface BufferLike {
  getLine(index: number): BufferLineLike | undefined;
}

// Read the logical line containing `cursorAbsRow` (an absolute row, `baseY +
// cursorY`). Walks up through wrapped rows to the line's start, then forward
// through its wrapped continuations, concatenating the rendered text.
export function readLogicalLineFromBuffer(buffer: BufferLike, cursorAbsRow: number): string | null {
  let start = cursorAbsRow;
  while (start > 0) {
    const line = buffer.getLine(start);
    if (!line || !line.isWrapped) break;
    start -= 1;
  }

  const first = buffer.getLine(start);
  if (!first) return null;

  let text = first.translateToString(false);
  for (let row = start + 1; ; row += 1) {
    const line = buffer.getLine(row);
    if (!line || !line.isWrapped) break;
    text += line.translateToString(false);
  }
  return text;
}
