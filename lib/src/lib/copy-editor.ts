import type { Terminal } from '@xterm/xterm';
import {
  COPY_FORMATS,
  comparePos,
  computeScopes,
  nudge,
  render,
  selectionOfSpan,
  spanEquals,
  spanOfSelection,
  terminalCopyBuffer,
  type BreakKind,
  type CopyBuffer,
  type CopyFormat,
  type Rendering,
  type Span,
} from './copy-text';
import {
  getMouseSelectionState,
  setCopyEditor,
  setSelection,
  type CopyEditorState,
  type Selection,
} from './mouse-selection';

// The copy editor's state transitions over the selection store, given the
// terminal whose buffer it reads (docs/specs/mouse-and-clipboard.md §4). The
// registry-aware wrappers that write the clipboard live in `copy-selection.ts`.

function editorFor(buf: CopyBuffer, span: Span, format: CopyFormat): CopyEditorState {
  return { scopes: computeScopes(buf, span), scope: 0, format, overrides: {} };
}

/** Open the editor over the finalized selection, at its own scope in Auto. */
export function openCopyEditor(id: string, terminal: Terminal): void {
  const sel = getMouseSelectionState(id).selection;
  if (sel && !sel.dragging) setCopyEditor(id, editorFor(terminalCopyBuffer(terminal), spanOfSelection(sel), 'auto'));
}

/** Every format over `scope`, before any per-break edit: what the format row
 *  compares, and the preview whenever nothing was edited. */
export function formatRenderings(terminal: Terminal, sel: Selection, scope: Span): Record<CopyFormat, Rendering> {
  const buf = terminalCopyBuffer(terminal);
  const original = spanOfSelection(sel);
  return Object.fromEntries(COPY_FORMATS.map((format) => [format, render(buf, scope, { original, format })])) as Record<CopyFormat, Rendering>;
}

/** What the editor shows and copies. */
export function editorRendering(terminal: Terminal, sel: Selection, editor: CopyEditorState, renderings?: Record<CopyFormat, Rendering>): Rendering {
  if (renderings && Object.keys(editor.overrides).length === 0) return renderings[editor.format];
  const scope = editor.scopes[editor.scope].span;
  return render(terminalCopyBuffer(terminal), scope, { original: spanOfSelection(sel), format: editor.format, overrides: editor.overrides });
}

/** Each format whose text an earlier one, in `f` order, already gives. */
export function duplicateFormats(renderings: Record<CopyFormat, Rendering>): Partial<Record<CopyFormat, CopyFormat>> {
  const seen = new Map<string, CopyFormat>();
  const sameAs: Partial<Record<CopyFormat, CopyFormat>> = {};
  for (const format of COPY_FORMATS) {
    const prior = seen.get(renderings[format].text);
    if (prior) sameAs[format] = prior;
    else seen.set(renderings[format].text, format);
  }
  return sameAs;
}

/** Choose a scope; a per-break edit belongs to the scope and format it was
 *  made in, so it is dropped. Out of range stays put. */
export function setCopyScope(id: string, scope: number): void {
  const editor = getMouseSelectionState(id).copyEditor;
  if (editor && scope !== editor.scope && editor.scopes[scope]) setCopyEditor(id, { ...editor, scope, overrides: {} });
}

/** `e` / `⬆︎e`: the next wider or narrower scope, stopping at either end. */
export function stepCopyScope(id: string, dir: 1 | -1): void {
  const editor = getMouseSelectionState(id).copyEditor;
  if (editor) setCopyScope(id, editor.scope + dir);
}

/** Choose a format, dropping per-break edits. */
export function setCopyFormat(id: string, format: CopyFormat): void {
  const editor = getMouseSelectionState(id).copyEditor;
  if (editor && (format !== editor.format || Object.keys(editor.overrides).length > 0)) {
    setCopyEditor(id, { ...editor, format, overrides: {} });
  }
}

/** `f` / `⬆︎f`: the next or previous format, wrapping. */
export function cycleCopyFormat(id: string, dir: 1 | -1): void {
  const editor = getMouseSelectionState(id).copyEditor;
  if (!editor) return;
  const at = COPY_FORMATS.indexOf(editor.format);
  setCopyFormat(id, COPY_FORMATS[(at + dir + COPY_FORMATS.length) % COPY_FORMATS.length]);
}

const NEXT_BREAK: Record<BreakKind, BreakKind> = { keep: 'space', space: 'none', none: 'keep' };

/** A click on a break mark showing `kind`: keep → space → none → keep. */
export function flipCopyBreak(id: string, index: number, kind: BreakKind): void {
  const editor = getMouseSelectionState(id).copyEditor;
  if (editor) setCopyEditor(id, { ...editor, overrides: { ...editor.overrides, [index]: NEXT_BREAK[kind] } });
}

/**
 * `◀ ▶` move the end a word, `⬆︎◀ ⬆︎▶` the start. The selection is rewritten in
 * reading order with a fresh editor at its own scope, keeping the format.
 */
export function nudgeCopyEdge(id: string, terminal: Terminal, edge: 'start' | 'end', dir: 1 | -1): void {
  const { selection: sel, copyEditor } = getMouseSelectionState(id);
  if (!sel || !copyEditor || sel.shape === 'block') return;
  const buf = terminalCopyBuffer(terminal);
  const span = spanOfSelection(sel);
  const moved: Span = edge === 'start'
    ? { ...span, start: nudge(buf, span.start, dir, 'start') }
    : { ...span, end: nudge(buf, span.end, dir, 'end') };
  if (spanEquals(moved, span) || comparePos(moved.start, moved.end) > 0) return;
  setSelection(id, selectionOfSpan(moved, sel), editorFor(buf, moved, copyEditor.format));
}
