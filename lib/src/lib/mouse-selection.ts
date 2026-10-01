/** DOM-free per-terminal mouse/selection store with a
 * `useSyncExternalStore`-compatible subscription API. */

import { comparePos, type BreakKind, type CopyBuffer, type EditorFormat, type Scope } from './copy-text';
import type { BufferToken } from './smart-token';

export type MouseTrackingMode = 'none' | 'x10' | 'vt200' | 'drag' | 'any';
export type OverrideState = 'off' | 'temporary' | 'permanent';
export type SelectionShape = 'linewise' | 'block';

export interface Selection {
  /** Absolute buffer row (scrollback + viewport), 0-indexed. */
  startRow: number;
  /** Cell column at the drag anchor. */
  startCol: number;
  /** Absolute buffer row. */
  endRow: number;
  /** Cell column at the current drag position (or release position). */
  endCol: number;
  shape: SelectionShape;
  /**
   * True when this drag was armed block-mode at its start — the touch
   * double-tap gesture, which has no Alt key to hold. The shape then stays
   * block for the whole drag, whatever a hardware Alt does (spec §3.2).
   */
  blockLatched?: boolean;
  /** True while the user is still dragging; false once the mouse is released. */
  dragging: boolean;
  /**
   * `'program'` for a drag the inside program owned, which Dormouse only
   * shadowed: no outline and no editor until the copy chord (spec §3.8).
   */
  owner?: 'program';
  /**
   * True when the drag originated in scrollback. Scrollback-origin drags are
   * always handled by the terminal regardless of the inside program's mouse
   * reporting (spec §3.5).
   */
  startedInScrollback: boolean;
}

/** The copy editor over a finalized selection (spec §4). */
export interface CopyEditorState {
  /** The buffer read when the editor opened, so what it shows is what it
   *  copies. */
  buffer: CopyBuffer;
  /** Narrowest first; `[0]` is the selection itself. */
  scopes: readonly Scope[];
  /** Index into {@link scopes}. */
  scope: number;
  format: EditorFormat;
  /** Break index → kind, for the current scope and format only. */
  overrides: Readonly<Record<number, BreakKind>>;
}


export interface MouseSelectionState {
  mouseReporting: MouseTrackingMode;
  bracketedPaste: boolean;
  override: OverrideState;
  selection: Selection | null;
  /** The token under a drag's head, in absolute buffer rows. */
  hintToken: BufferToken | null;
  /** Open while non-null: always the editor written with this exact
   *  `selection`, which is finalized. */
  copyEditor: CopyEditorState | null;
  /** The program's own `OSC 52` text, offered while it holds a shadowed drag
   *  (spec §4.6); it goes with the selection. */
  programCopy: string | null;
  /** What the latest copy did, set briefly: a confirmed copy, after which
   *  the selection clears, or a failed write, which keeps it for a retry. */
  copyOutcome: CopyOutcome | null;
}

/** What a copy did, as its Copy button says (spec §4.5). */
export type CopyOutcome = 'copied' | 'failed';

export const DEFAULT_MOUSE_SELECTION_STATE: MouseSelectionState = Object.freeze({
  mouseReporting: 'none',
  bracketedPaste: false,
  override: 'off',
  selection: null,
  hintToken: null,
  copyEditor: null,
  programCopy: null,
  copyOutcome: null,
}) as MouseSelectionState;

const states = new Map<string, MouseSelectionState>();
const listeners = new Set<() => void>();
let cachedSnapshot: Map<string, MouseSelectionState> | null = null;

/** Everything that belongs to a selection, so a writer that drops or replaces
 *  one cannot leave another's editor, offer, or flash behind. */
function clearSelection(s: MouseSelectionState): void {
  s.selection = null;
  s.copyEditor = null;
  s.programCopy = null;
  s.copyOutcome = null;
  s.hintToken = null;
}

/** A drag the program owned, shadowed and waiting for the copy chord (§3.8). */
export function isShadowed(state: MouseSelectionState): boolean {
  return state.selection?.owner === 'program' && !state.copyEditor;
}

function notify(): void {
  cachedSnapshot = null;
  listeners.forEach((l) => l());
}

function ensure(id: string): MouseSelectionState {
  let s = states.get(id);
  if (!s) {
    s = { ...DEFAULT_MOUSE_SELECTION_STATE };
    states.set(id, s);
  }
  return s;
}

export function subscribeToMouseSelection(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getMouseSelectionSnapshot(): Map<string, MouseSelectionState> {
  if (cachedSnapshot) return cachedSnapshot;
  cachedSnapshot = new Map(states);
  return cachedSnapshot;
}

export function getMouseSelectionState(id: string): MouseSelectionState {
  return states.get(id) ?? DEFAULT_MOUSE_SELECTION_STATE;
}

export function setMouseReporting(id: string, mode: MouseTrackingMode): void {
  const s = ensure(id);
  if (s.mouseReporting === mode) return;
  s.mouseReporting = mode;
  // Spec §2 (auto-clear on reporting off): with nothing left to override, end it.
  if (mode === 'none' && s.override !== 'off') {
    s.override = 'off';
  }
  // A shadowed drag (§3.8) belonged to the program that just stopped reporting.
  if (mode === 'none' && s.selection?.owner === 'program') clearSelection(s);
  notify();
}

export function setBracketedPaste(id: string, on: boolean): void {
  const s = ensure(id);
  if (s.bracketedPaste === on) return;
  s.bracketedPaste = on;
  notify();
}

export function setOverride(id: string, override: OverrideState): void {
  const s = ensure(id);
  if (s.override === override) return;
  // Override only makes sense while the inside program is requesting mouse
  // reporting. Ignore attempts to activate it otherwise.
  if (override !== 'off' && s.mouseReporting === 'none') return;
  s.override = override;
  notify();
}

/**
 * Replace the selection and, in the same write, the copy editor over it: none
 * unless one is given for a finalized selection, so an editor never outlives
 * the selection it was opened for.
 */
export function setSelection(id: string, selection: Selection | null, copyEditor: CopyEditorState | null = null): void {
  const s = ensure(id);
  if (s.selection === null && selection === null) return;
  if (selection === null) clearSelection(s);
  else {
    // A replaced selection keeps an in-flight flash and the drag's hint, but
    // not the program's offer, so its editor cannot show that offer either.
    s.selection = selection;
    s.programCopy = null;
    s.copyEditor = selection.dragging || !copyEditor ? null
      : copyEditor.format === 'program' ? { ...copyEditor, format: 'auto', overrides: {} } : copyEditor;
  }
  notify();
}

/** Take a program's `OSC 52` text as an offer, but only into a pane holding a
 *  shadowed drag (spec §4.6); dropped anywhere else. */
export function offerProgramCopy(id: string, text: string): void {
  const s = states.get(id);
  if (s?.selection?.owner !== 'program' || s.programCopy === text) return;
  s.programCopy = text;
  notify();
}

/** Open or update the editor over the current finalized selection; a no-op
 *  without one, or for the program's format without its offer. */
export function setCopyEditor(id: string, editor: CopyEditorState): void {
  const s = ensure(id);
  if (!s.selection || s.selection.dragging || s.copyEditor === editor) return;
  if (editor.format === 'program' && s.programCopy === null) return;
  s.copyEditor = editor;
  notify();
}

/**
 * Begin a new drag. Replaces any existing selection (spec §3.7: starting a
 * new drag in the terminal content area replaces the existing selection).
 */
export function beginDrag(
  id: string,
  args: { row: number; col: number; altKey: boolean; blockLatched?: boolean; startedInScrollback: boolean },
): void {
  const s = ensure(id);
  // Clearing the in-flight copy flash too keeps its timer from clearing this
  // new selection when it fires.
  clearSelection(s);
  s.selection = {
    startRow: args.row,
    startCol: args.col,
    endRow: args.row,
    endCol: args.col,
    shape: args.altKey || args.blockLatched ? 'block' : 'linewise',
    ...(args.blockLatched ? { blockLatched: true } : {}),
    dragging: true,
    startedInScrollback: args.startedInScrollback,
  };
  notify();
}

/**
 * Update an in-progress drag. No-op if no drag is active or the drag has
 * already been released. The shape can flip live as Alt is pressed / released
 * (spec §3.2). `anchor` moves the drag's origin cell too: which cell a pointer
 * boundary selects depends on which side of it the drag ends (§3.1).
 */
export function updateDrag(
  id: string,
  args: { row: number; col: number; altKey: boolean; anchor?: { row: number; col: number } },
): void {
  const s = ensure(id);
  const sel = s.selection;
  if (!sel || !sel.dragging) return;
  const shape: SelectionShape = args.altKey || sel.blockLatched ? 'block' : 'linewise';
  const startRow = args.anchor?.row ?? sel.startRow;
  const startCol = args.anchor?.col ?? sel.startCol;
  if (sel.endRow === args.row && sel.endCol === args.col && sel.shape === shape && sel.startRow === startRow && sel.startCol === startCol) return;
  s.selection = { ...sel, startRow, startCol, endRow: args.row, endCol: args.col, shape };
  notify();
}

/**
 * Finalize the drag. Selection remains but is no longer in the dragging
 * state. Subsequent mouse moves are ignored until a new drag starts. No-op
 * if no drag is active.
 */
export function endDrag(id: string): void {
  const s = ensure(id);
  const sel = s.selection;
  if (!sel || !sel.dragging) return;
  s.selection = { ...sel, dragging: false };
  notify();
}

/** True if a drag is currently in progress. */
export function isDragging(id: string): boolean {
  const s = states.get(id);
  return !!s?.selection?.dragging;
}

/**
 * True when xterm is in a mouse-reporting mode AND the user is in a context
 * where the host (not the PTY) should own the mouse — i.e. an active override
 * or a selection that began in scrollback.
 */
export function stateRequiresNativeMouseSuppression(state: MouseSelectionState): boolean {
  return state.mouseReporting !== 'none'
    && (state.override !== 'off' || state.selection?.startedInScrollback === true);
}

/**
 * Extend the in-progress selection to fully cover a detected token (spec §5.3).
 * No-op when no drag is active. Preserves the drag anchor; adjusts the end
 * toward whichever token boundary is farther from the anchor so the drag
 * direction is respected.
 */
export function extendSelectionToToken(id: string, token: BufferToken): void {
  const s = states.get(id);
  if (!s?.selection?.dragging) return;
  const sel = s.selection;
  const forward = comparePos({ row: sel.startRow, col: sel.startCol }, token.start) <= 0;
  const edge = forward ? token.end : token.start;
  s.selection = { ...sel, endRow: edge.row, endCol: edge.col };
  notify();
}

/** How long a confirmed copy shows before the selection clears (spec §4.5):
 *  longer on touch, where the finger covers the button and the eye arrives late. */
export const COPY_FLASH_MS = 700;
export const TOUCH_COPY_FLASH_MS = 1200;
/** How long a failed copy says so, the selection kept. */
export const COPY_FAILED_MS = 1500;

/** Each state's latest copy outcome, so a timer acts only for its own. */
const outcomes = new WeakMap<MouseSelectionState, object>();

/** Show `outcome` for `durationMs`, unless the selection or a newer outcome
 *  replaces it: then a confirmed copy clears the selection, dismissing the
 *  editor whatever moved the selection meanwhile, and a failure clears only
 *  itself. */
function showCopyOutcome(id: string, s: MouseSelectionState, outcome: CopyOutcome, durationMs: number): void {
  const token = {};
  outcomes.set(s, token);
  s.copyOutcome = outcome;
  notify();
  setTimeout(() => {
    if (states.get(id) !== s || outcomes.get(s) !== token || s.copyOutcome === null) return;
    if (outcome === 'copied') clearSelection(s);
    else s.copyOutcome = null;
    notify();
  }, durationMs);
}

/** Confirm a copy, the selection clearing after `durationMs`. */
export function flashCopy(id: string, durationMs = COPY_FLASH_MS): void {
  showCopyOutcome(id, ensure(id), 'copied', durationMs);
}

/** Say a copy failed, keeping the selection for a retry; a no-op without one. */
export function failCopy(id: string): void {
  const s = states.get(id);
  if (s?.selection) showCopyOutcome(id, s, 'failed', COPY_FAILED_MS);
}

const sameToken = (a: BufferToken | null, b: BufferToken | null) => a === b || (!!a && !!b
  && a.kind === b.kind && a.text === b.text && comparePos(a.start, b.start) === 0 && comparePos(a.end, b.end) === 0);

/** Set the drag's token hint. Every drag move sets it, and a write rebuilds
 *  every pane's snapshot, so the same token writes nothing. */
export function setHintToken(id: string, hint: BufferToken | null): void {
  const s = ensure(id);
  if (sameToken(s.hintToken, hint)) return;
  s.hintToken = hint;
  notify();
}

export function removeMouseSelectionState(id: string): void {
  if (!states.has(id)) return;
  states.delete(id);
  notify();
}

// --- Render tick ---
//
// A tiny counter that terminal-lifecycle bumps whenever xterm renders (scroll,
// resize, output arrives). The selection overlay subscribes to this so it
// re-measures and re-positions its rectangles whenever anything that could
// affect cell layout happens.

let renderTick = 0;
const renderTickListeners = new Set<() => void>();

export function subscribeToRenderTick(listener: () => void): () => void {
  renderTickListeners.add(listener);
  return () => {
    renderTickListeners.delete(listener);
  };
}

export function getRenderTick(): number {
  return renderTick;
}

export function bumpRenderTick(): void {
  renderTick++;
  renderTickListeners.forEach((l) => l());
}

/** Test-only helper. Do not use in application code. */
export function __resetMouseSelectionForTests(): void {
  states.clear();
  listeners.clear();
  cachedSnapshot = null;
  renderTick = 0;
  renderTickListeners.clear();
}
