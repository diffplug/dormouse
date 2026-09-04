// Terminal source pins (docs/specs/notepad.md): the runtime-only link from a
// captured note back to the scrollback it came from. Two xterm markers ride the
// buffer as it scrolls, and the raw text captured alongside them is the proof —
// column restoration after a resize is best effort, so a pin resolves only when
// the rebuilt range reads back byte for byte.
import type { IMarker, Terminal } from '@xterm/xterm';
import { setSelection, type Selection } from '../mouse-selection';
import { extractSelectionText, normalizeSelection } from '../selection-text';
import { getTerminalInstance } from '../terminal-registry';
import type { RuntimeTerminalSource } from './types';

/** Minimal slice of an xterm.js `IBufferLine`. */
export interface SourceLineLike {
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

/** Minimal slice of an xterm.js `IBuffer`. */
export interface SourceBufferLike {
  readonly type: 'normal' | 'alternate';
  readonly baseY: number;
  readonly cursorY: number;
  readonly length: number;
  getLine(y: number): SourceLineLike | undefined;
}

/** Minimal slice of an xterm.js `Terminal`; a real `Terminal` satisfies it. */
export interface SourceTerminalLike {
  readonly cols: number;
  readonly buffer: { readonly active: SourceBufferLike };
  registerMarker(cursorYOffset?: number): IMarker | undefined;
}

export type ResolvedSource =
  | { ok: true; selection: Selection }
  | { ok: false; reason: 'disposed' | 'missing-rows' | 'mismatch' };

/**
 * Pin a capture to its place in the normal buffer. Returns `null` for an
 * alternate-buffer capture: xterm registers markers on the normal buffer only,
 * and a full-screen program's grid is rewritten in place, so there is nothing
 * stable to point at.
 */
export function registerTerminalSource(
  terminal: SourceTerminalLike,
  terminalId: string,
  sel: Selection,
  rawText: string,
): RuntimeTerminalSource | null {
  const buf = terminal.buffer.active;
  if (buf.type === 'alternate') return null;

  const n = normalizeSelection(sel);
  // Markers are registered cursor-relative; a negative offset reaches back into
  // scrollback, which is where most captures live.
  const cursorRow = buf.baseY + buf.cursorY;
  const startMarker = terminal.registerMarker(n.r0 - cursorRow);
  if (!startMarker || startMarker.isDisposed) return null;
  const endMarker = terminal.registerMarker(n.r1 - cursorRow);
  if (!endMarker || endMarker.isDisposed) {
    startMarker.dispose();
    endMarker?.dispose();
    return null;
  }

  return {
    terminalId,
    startMarker,
    endMarker,
    startColumn: n.c0,
    endColumn: n.c1,
    shape: sel.shape,
    expectedRawText: rawText,
  };
}

/**
 * Rebuild the captured range from the markers' current lines and the stored
 * columns, then prove it: the candidate range must read back exactly the text
 * captured with it. A resize that reflowed the output, scrollback that trimmed
 * away, or a program that overwrote the rows all surface here rather than
 * scrolling the user to the wrong place.
 */
export function resolveTerminalSource(
  terminal: SourceTerminalLike,
  source: RuntimeTerminalSource,
): ResolvedSource {
  const { startMarker, endMarker } = source;
  if (startMarker.isDisposed || endMarker.isDisposed) return { ok: false, reason: 'disposed' };

  const startRow = startMarker.line;
  const endRow = endMarker.line;
  const buf = terminal.buffer.active;
  // A disposed marker reports -1, and the alternate buffer being active leaves
  // the rows out of range — both land here rather than reading foreign content.
  if (startRow < 0 || endRow < startRow || endRow >= buf.length) {
    return { ok: false, reason: 'missing-rows' };
  }
  if (!buf.getLine(startRow) || !buf.getLine(endRow)) return { ok: false, reason: 'missing-rows' };

  const selection: Selection = {
    startRow,
    startCol: source.startColumn,
    endRow,
    endCol: source.endColumn,
    shape: source.shape,
    dragging: false,
    startedInScrollback: startRow < buf.baseY,
  };
  if (extractSelectionText(terminal as Terminal, selection) !== source.expectedRawText) {
    return { ok: false, reason: 'mismatch' };
  }
  return { ok: true, selection };
}

/** Release both markers. Called when the pin is removed, the note is deleted,
 *  or the terminal instance goes away. */
export function disposeTerminalSource(source: RuntimeTerminalSource): void {
  source.startMarker.dispose();
  source.endMarker.dispose();
}

/**
 * Show a resolved range: scroll it into view if it is off screen, then set the
 * Dormouse selection, which is what draws the outline and raises the finalized
 * selection popup.
 */
export function revealResolvedSource(terminalId: string, selection: Selection): void {
  const terminal = getTerminalInstance(terminalId);
  if (!terminal) return;
  const buf = terminal.buffer.active;
  const top = normalizeSelection(selection).r0;
  if (top < buf.viewportY || top > buf.viewportY + terminal.rows - 1) {
    // `baseY` is the furthest the viewport can scroll; without the clamp a
    // range near the bottom would ask for a scroll position that does not exist.
    terminal.scrollToLine(Math.max(0, Math.min(top, buf.baseY)));
  }
  setSelection(terminalId, selection);
}
