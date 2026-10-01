import type { Terminal } from '@xterm/xterm';
import {
  COPY_FORMATS,
  comparePos,
  computeScopes,
  nudge,
  render,
  renderText,
  selectionOfSpan,
  spanEquals,
  spanOfSelection,
  terminalCopyBuffer,
  type BreakKind,
  type CopyBuffer,
  type EditorFormat,
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

function editorFor(buf: CopyBuffer, span: Span, format: EditorFormat): CopyEditorState {
  return { scopes: computeScopes(buf, span), scope: 0, format, overrides: {} };
}

/** Open the editor over the finalized selection, at its own scope in Auto. */
export function openCopyEditor(id: string, terminal: Terminal): void {
  const sel = getMouseSelectionState(id).selection;
  if (sel && !sel.dragging) setCopyEditor(id, editorFor(terminalCopyBuffer(terminal), spanOfSelection(sel), 'auto'));
}

/** The formats the editor offers, in `f` order: the program's own copy last,
 *  when it sent one (spec §4.6). */
export function editorFormats(programCopy: string | null): readonly EditorFormat[] {
  return programCopy === null ? COPY_FORMATS : [...COPY_FORMATS, 'program'];
}

export type FormatRenderings = Partial<Record<EditorFormat, Rendering>>;

/** Every format over `scope`, before any per-break edit: what the format row
 *  compares, and the preview whenever nothing was edited. */
export function formatRenderings(terminal: Terminal, sel: Selection, scope: Span, programCopy: string | null): FormatRenderings {
  const buf = terminalCopyBuffer(terminal);
  const original = spanOfSelection(sel);
  const out: FormatRenderings = {};
  for (const format of COPY_FORMATS) out[format] = render(buf, scope, { original, format });
  if (programCopy !== null) out.program = renderText(programCopy);
  return out;
}

/** What the editor shows and copies. */
export function editorRendering(
  terminal: Terminal,
  sel: Selection,
  editor: CopyEditorState,
  programCopy: string | null,
  renderings?: FormatRenderings,
): Rendering {
  const unedited = Object.keys(editor.overrides).length === 0;
  const cached = unedited ? renderings?.[editor.format] : undefined;
  if (cached) return cached;
  if (editor.format === 'program') return renderText(programCopy ?? '', editor.overrides);
  const scope = editor.scopes[editor.scope].span;
  return render(terminalCopyBuffer(terminal), scope, { original: spanOfSelection(sel), format: editor.format, overrides: editor.overrides });
}

/** Each format whose text an earlier one, in `f` order, already gives. */
export function duplicateFormats(renderings: FormatRenderings): Partial<Record<EditorFormat, EditorFormat>> {
  const seen = new Map<string, EditorFormat>();
  const sameAs: Partial<Record<EditorFormat, EditorFormat>> = {};
  for (const [format, rendering] of Object.entries(renderings) as [EditorFormat, Rendering][]) {
    const prior = seen.get(rendering.text);
    if (prior) sameAs[format] = prior;
    else seen.set(rendering.text, format);
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

/** Choose a format, dropping per-break edits; the program's copy only when
 *  it sent one. */
export function setCopyFormat(id: string, format: EditorFormat): void {
  const { copyEditor: editor, programCopy } = getMouseSelectionState(id);
  if (!editor || !editorFormats(programCopy).includes(format)) return;
  if (format !== editor.format || Object.keys(editor.overrides).length > 0) {
    setCopyEditor(id, { ...editor, format, overrides: {} });
  }
}

/** `f` / `⬆︎f`: the next or previous format, wrapping. */
export function cycleCopyFormat(id: string, dir: 1 | -1): void {
  const { copyEditor: editor, programCopy } = getMouseSelectionState(id);
  if (!editor) return;
  const formats = editorFormats(programCopy);
  const at = Math.max(0, formats.indexOf(editor.format));
  setCopyFormat(id, formats[(at + dir + formats.length) % formats.length]);
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
  // A moved selection is no longer what the program copied.
  const format = copyEditor.format === 'program' ? 'auto' : copyEditor.format;
  const buf = terminalCopyBuffer(terminal);
  const span = spanOfSelection(sel);
  const moved: Span = edge === 'start'
    ? { ...span, start: nudge(buf, span.start, dir, 'start') }
    : { ...span, end: nudge(buf, span.end, dir, 'end') };
  if (spanEquals(moved, span) || comparePos(moved.start, moved.end) > 0) return;
  setSelection(id, selectionOfSpan(moved, sel), editorFor(buf, moved, format));
}
