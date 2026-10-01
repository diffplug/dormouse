import type { Terminal } from '@xterm/xterm';
import {
  COPY_FORMATS,
  comparePos,
  computeScopes,
  nudge,
  render,
  spanOfSelection,
  terminalCopyBuffer,
  type BreakKind,
  type CopyFormat,
  type Rendering,
  type Scope,
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

function initialEditor(terminal: Terminal, sel: Selection): CopyEditorState {
  const scopes = computeScopes(terminalCopyBuffer(terminal), spanOfSelection(sel), sel.shape === 'block');
  return { scopes, scope: 0, format: 'auto', overrides: {} };
}

/** Open the editor over the finalized selection, at its own scope in Auto. */
export function openCopyEditor(id: string, terminal: Terminal): void {
  const sel = getMouseSelectionState(id).selection;
  if (!sel || sel.dragging) return;
  setCopyEditor(id, initialEditor(terminal, sel));
}

export interface CopyEditorView {
  scope: Scope;
  rendering: Rendering;
  /** Each format whose text another, earlier one already gives. */
  sameAs: Partial<Record<CopyFormat, CopyFormat>>;
}

/** What the editor shows and copies. Without an open editor, Auto at the
 *  selection's own scope. */
export function copyEditorView(terminal: Terminal, sel: Selection, editor: CopyEditorState | null): CopyEditorView {
  const state = editor ?? initialEditor(terminal, sel);
  const buf = terminalCopyBuffer(terminal);
  const original = spanOfSelection(sel);
  const block = sel.shape === 'block';
  const scope = state.scopes[Math.min(state.scope, state.scopes.length - 1)];
  const rendering = render(buf, scope.span, { original, format: state.format, block, overrides: state.overrides });
  const seen = new Map<string, CopyFormat>();
  const sameAs: CopyEditorView['sameAs'] = {};
  for (const format of COPY_FORMATS) {
    const text = render(buf, scope.span, { original, format, block }).text;
    const prior = seen.get(text);
    if (prior) sameAs[format] = prior;
    else seen.set(text, format);
  }
  return { scope, rendering, sameAs };
}

function update(id: string, change: (editor: CopyEditorState) => CopyEditorState | null): void {
  const editor = getMouseSelectionState(id).copyEditor;
  if (!editor) return;
  const next = change(editor);
  if (next) setCopyEditor(id, next);
}

/** `e` / `⬆︎e`: the next wider or narrower scope, stopping at either end. */
export function stepCopyScope(id: string, dir: 1 | -1): void {
  update(id, (e) => {
    const scope = Math.max(0, Math.min(e.scopes.length - 1, e.scope + dir));
    return scope === e.scope ? null : { ...e, scope, overrides: {} };
  });
}

export function setCopyScope(id: string, scope: number): void {
  update(id, (e) => (scope === e.scope || !e.scopes[scope] ? null : { ...e, scope, overrides: {} }));
}

/** `f` / `⬆︎f`: the next or previous format, wrapping. */
export function cycleCopyFormat(id: string, dir: 1 | -1): void {
  update(id, (e) => {
    const at = COPY_FORMATS.indexOf(e.format);
    const format = COPY_FORMATS[(at + dir + COPY_FORMATS.length) % COPY_FORMATS.length];
    return { ...e, format, overrides: {} };
  });
}

export function setCopyFormat(id: string, format: CopyFormat): void {
  update(id, (e) => (format === e.format && Object.keys(e.overrides).length === 0 ? null : { ...e, format, overrides: {} }));
}

const NEXT_BREAK: Record<BreakKind, BreakKind> = { keep: 'space', space: 'none', none: 'keep' };

/** A click on a break mark: keep → space → none → keep. */
export function flipCopyBreak(id: string, terminal: Terminal, index: number): void {
  const { selection, copyEditor } = getMouseSelectionState(id);
  if (!selection || !copyEditor) return;
  const { rendering } = copyEditorView(terminal, selection, copyEditor);
  const current = copyEditor.overrides[index] ?? rendering.breaks[index];
  if (!current) return;
  setCopyEditor(id, { ...copyEditor, overrides: { ...copyEditor.overrides, [index]: NEXT_BREAK[current] } });
}

/**
 * `◀ ▶` move the end a word, `⬆︎◀ ⬆︎▶` the start. The selection is rewritten in
 * reading order and the editor returns to its own scope, keeping its format.
 * Returns whether the
 * selection moved, so the caller can re-arm its cancel-on-change baseline.
 */
export function nudgeCopyEdge(id: string, terminal: Terminal, edge: 'start' | 'end', dir: 1 | -1): boolean {
  const sel = getMouseSelectionState(id).selection;
  if (!sel || sel.dragging || sel.shape === 'block') return false;
  const buf = terminalCopyBuffer(terminal);
  const span = spanOfSelection(sel);
  const moved = edge === 'start'
    ? { start: nudge(buf, span.start, dir, 'start'), end: span.end }
    : { start: span.start, end: nudge(buf, span.end, dir, 'end') };
  if (comparePos(moved.start, moved.end) > 0) return false;
  if (comparePos(moved.start, span.start) === 0 && comparePos(moved.end, span.end) === 0) return false;
  const next: Selection = {
    ...sel,
    startRow: moved.start.row,
    startCol: moved.start.col,
    endRow: moved.end.row,
    endCol: moved.end.col,
  };
  const format = getMouseSelectionState(id).copyEditor?.format ?? 'auto';
  setSelection(id, next);
  setCopyEditor(id, { ...initialEditor(terminal, next), format });
  return true;
}
