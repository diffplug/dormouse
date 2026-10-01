// Reading the typed command region of the cursor's logical line from the
// rendered terminal buffer. At submit time this is the `prompt + command` line;
// terminal-prompt-shape.ts strips the prompt off the front. We read from the
// logical start up to the live cursor column — not the end of the line — so a
// zsh-autosuggestions ghost suggestion (dim text rendered after the cursor) is
// excluded. Reading at submit keeps it timing-independent (unlike capturing a
// prompt-boundary anchor on the first keystroke, which races shell output).

import { wrapRun } from './buffer-cells';

/** Minimal slice of an xterm.js `IBufferLine`, kept tiny so this is unit-testable. */
export interface BufferLineLike {
  readonly isWrapped: boolean;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

/** Minimal slice of an xterm.js `IBuffer`. */
export interface BufferLike {
  readonly length: number;
  getLine(index: number): BufferLineLike | undefined;
}

// Read the logical line containing the cursor up to `cursorCol`. `cursorAbsRow`
// is an absolute row (`baseY + cursorY`). Joins the line's soft-wrapped rows
// from its start up to the cursor's row, bounding that row at the cursor
// column so anything to its right (autosuggest ghost text) is dropped.
export function readLogicalLineFromBuffer(
  buffer: BufferLike,
  cursorAbsRow: number,
  cursorCol: number,
): string | null {
  const { top, lines } = wrapRun(buffer, cursorAbsRow);
  if (!lines.length) return null;
  let text = '';
  for (let row = top; row <= cursorAbsRow; row += 1) {
    text += lines[row - top].translateToString(false, 0, row === cursorAbsRow ? cursorCol : undefined);
  }
  return text;
}
