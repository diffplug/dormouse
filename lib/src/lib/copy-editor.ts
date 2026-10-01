import type { Terminal } from '@xterm/xterm';
import {
  COPY_FORMATS,
  comparePos,
  computeScopes,
  nudge,
  readScope,
  renderLines,
  renderText,
  selectionOfSpan,
  spanEquals,
  spanOfSelection,
  terminalCopyBuffer,
  type BreakKind,
  type CopyBuffer,
  type CopyFormat,
  type EditorFormat,
  type Rendering,
  type ScopeLines,
  type Span,
} from './copy-text';
import { getMouseSelectionState, setCopyEditor, setSelection, type CopyEditorState } from './mouse-selection';
import { registry } from './terminal-store';

// The copy editor's state transitions over the selection store
// (docs/specs/mouse-and-clipboard.md §4). Every reading goes through the buffer
// the editor opened with; only opening reads the terminal.

function editorFor(buffer: CopyBuffer, span: Span, format: EditorFormat): CopyEditorState {
  return { buffer, scopes: computeScopes(buffer, span), scope: 0, format, overrides: {} };
}

/** Open the editor over the finalized selection, at its own scope in Auto. */
export function openCopyEditor(id: string, terminal: Terminal | undefined = registry.get(id)?.terminal): void {
  const sel = getMouseSelectionState(id).selection;
  if (terminal && sel && !sel.dragging) setCopyEditor(id, editorFor(terminalCopyBuffer(terminal), spanOfSelection(sel), 'auto'));
}

export type FormatRenderings = Partial<Record<EditorFormat, Rendering>>;

interface ScopeCache { lines: ScopeLines; renderings: Record<CopyFormat, Rendering> }
/** Per scope span, which lives as long as the editor that holds it. */
const scopeCache = new WeakMap<Span, ScopeCache>();

function scopeOf(editor: CopyEditorState): ScopeCache {
  const span = editor.scopes[editor.scope].span;
  let cached = scopeCache.get(span);
  if (!cached) {
    const lines = readScope(editor.buffer, span, editor.scopes[0].span);
    const renderings = Object.fromEntries(COPY_FORMATS.map((f) => [f, renderLines(lines, f)])) as Record<CopyFormat, Rendering>;
    cached = { lines, renderings };
    scopeCache.set(span, cached);
  }
  return cached;
}

/** The formats the editor offers, in `f` order: the program's own copy last,
 *  when it sent one (spec §4.6). */
export function editorFormats(programCopy: string | null): readonly EditorFormat[] {
  return programCopy === null ? COPY_FORMATS : [...COPY_FORMATS, 'program'];
}

/** Every format at the editor's scope, before any per-break edit: what the
 *  format row compares. */
export function formatRenderings(editor: CopyEditorState, programCopy: string | null): FormatRenderings {
  const { renderings } = scopeOf(editor);
  return programCopy === null ? renderings : { ...renderings, program: renderText(programCopy) };
}

export const isEdited = (editor: CopyEditorState) => Object.keys(editor.overrides).length > 0;

/** What the editor shows and copies. */
export function editorRendering(editor: CopyEditorState, programCopy: string | null): Rendering {
  // The store never holds the program format without its offer.
  if (editor.format === 'program') return renderText(programCopy!, editor.overrides);
  const cached = scopeOf(editor);
  return isEdited(editor) ? renderLines(cached.lines, editor.format, editor.overrides) : cached.renderings[editor.format];
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
 *  made in, so it is dropped. Out of range stays put, and the program's own
 *  copy has no scope to choose. */
export function setCopyScope(id: string, scope: number): void {
  const editor = getMouseSelectionState(id).copyEditor;
  if (!editor || editor.format === 'program' || scope === editor.scope || !editor.scopes[scope]) return;
  setCopyEditor(id, { ...editor, scope, overrides: {} });
}

/** `e` / `⬆︎e`: the next wider or narrower scope, stopping at either end. */
export function stepCopyScope(id: string, dir: 1 | -1): void {
  const editor = getMouseSelectionState(id).copyEditor;
  if (editor) setCopyScope(id, editor.scope + dir);
}

/** Choose a format, dropping per-break edits; the program's own copy returns
 *  to the selection's scope, since it ignores scope. */
export function setCopyFormat(id: string, format: EditorFormat): void {
  const editor = getMouseSelectionState(id).copyEditor;
  if (editor && (format !== editor.format || isEdited(editor))) {
    setCopyEditor(id, { ...editor, format, scope: format === 'program' ? 0 : editor.scope, overrides: {} });
  }
}

/** `f` / `⬆︎f`: the next or previous format, wrapping. */
export function cycleCopyFormat(id: string, dir: 1 | -1): void {
  const { copyEditor: editor, programCopy } = getMouseSelectionState(id);
  if (!editor) return;
  const formats = editorFormats(programCopy);
  setCopyFormat(id, formats[(formats.indexOf(editor.format) + dir + formats.length) % formats.length]);
}

const NEXT_BREAK: Record<BreakKind, BreakKind> = { keep: 'space', space: 'none', none: 'keep' };

/** A click on a break mark showing `kind`: keep → space → none → keep. */
export function flipCopyBreak(id: string, index: number, kind: BreakKind): void {
  const editor = getMouseSelectionState(id).copyEditor;
  if (editor) setCopyEditor(id, { ...editor, overrides: { ...editor.overrides, [index]: NEXT_BREAK[kind] } });
}

/**
 * `◀ ▶` move the end a word, `⬆︎◀ ⬆︎▶` the start. The selection is rewritten in
 * reading order with a fresh editor at its own scope, keeping the format (the
 * store demotes the program's, whose offer goes with the old selection).
 */
export function nudgeCopyEdge(id: string, edge: 'start' | 'end', dir: 1 | -1): void {
  const { selection: sel, copyEditor } = getMouseSelectionState(id);
  if (!sel || !copyEditor || sel.shape === 'block') return;
  const buf = copyEditor.buffer;
  const span = spanOfSelection(sel);
  const moved: Span = edge === 'start'
    ? { ...span, start: nudge(buf, span.start, dir, 'start') }
    : { ...span, end: nudge(buf, span.end, dir, 'end') };
  if (spanEquals(moved, span) || comparePos(moved.start, moved.end) > 0) return;
  setSelection(id, selectionOfSpan(moved, sel), editorFor(buf, moved, copyEditor.format));
}
