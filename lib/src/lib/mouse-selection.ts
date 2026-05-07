/**
 * Per-terminal mouse and selection state.
 *
 * Owns the data that the mouse-and-clipboard feature needs:
 * - Which mouse-reporting regime the inside program requested.
 * - Whether bracketed paste is on.
 * - Whether the user has activated an override (temporary / permanent).
 * - The current text selection and the current smart-extension hint.
 *
 * Exposes a `useSyncExternalStore`-compatible subscription API. Pure state,
 * no DOM dependencies — safe to unit-test.
 */

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
  /** True while the user is still dragging; false once the mouse is released. */
  dragging: boolean;
  /**
   * True when the drag originated in scrollback. Scrollback-origin drags are
   * always handled by the terminal regardless of the inside program's mouse
   * reporting (spec §3.5).
   */
  startedInScrollback: boolean;
}

export interface TokenHint {
  kind: 'url' | 'path';
  /** Absolute buffer row the token occupies. */
  row: number;
  startCol: number;
  /** Exclusive. */
  endCol: number;
  text: string;
}

export type CopyFlashKind = 'raw' | 'rewrapped';

export interface MouseSelectionState {
  mouseReporting: MouseTrackingMode;
  bracketedPaste: boolean;
  override: OverrideState;
  selection: Selection | null;
  hintToken: TokenHint | null;
  /**
   * Set briefly after Cmd+C / Cmd+Shift+C or a popup-button click, so the
   * popup can flash a "Copied!" confirmation before everything clears.
   */
  copyFlash: CopyFlashKind | null;
}

export const DEFAULT_MOUSE_SELECTION_STATE: MouseSelectionState = Object.freeze({
  mouseReporting: 'none',
  bracketedPaste: false,
  override: 'off',
  selection: null,
  hintToken: null,
  copyFlash: null,
}) as MouseSelectionState;

const states = new Map<string, MouseSelectionState>();
const listeners = new Set<() => void>();
let cachedSnapshot: Map<string, MouseSelectionState> | null = null;

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
  // Per spec §1.1 / §2: when the inside program stops requesting mouse reporting,
  // any active override is no longer meaningful. End it.
  if (mode === 'none' && s.override !== 'off') {
    s.override = 'off';
  }
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

export function setSelection(id: string, selection: Selection | null): void {
  const s = ensure(id);
  if (s.selection === null && selection === null) return;
  s.selection = selection;
  notify();
}

/**
 * Begin a new drag. Replaces any existing selection (spec §3.7: starting a
 * new drag in the terminal content area replaces the existing selection).
 */
export function beginDrag(
  id: string,
  args: { row: number; col: number; altKey: boolean; startedInScrollback: boolean },
): void {
  const s = ensure(id);
  // Clear any in-flight copy flash so its timer won't null out this new
  // selection when it fires (the timer checks `copyFlash !== kind`).
  s.copyFlash = null;
  s.selection = {
    startRow: args.row,
    startCol: args.col,
    endRow: args.row,
    endCol: args.col,
    shape: args.altKey ? 'block' : 'linewise',
    dragging: true,
    startedInScrollback: args.startedInScrollback,
  };
  notify();
}

/**
 * Update an in-progress drag. No-op if no drag is active or the drag has
 * already been released. The shape can flip live as Alt is pressed / released
 * (spec §3.2).
 */
export function updateDrag(
  id: string,
  args: { row: number; col: number; altKey: boolean },
): void {
  const s = ensure(id);
  const sel = s.selection;
  if (!sel || !sel.dragging) return;
  const shape: SelectionShape = args.altKey ? 'block' : 'linewise';
  if (sel.endRow === args.row && sel.endCol === args.col && sel.shape === shape) return;
  s.selection = { ...sel, endRow: args.row, endCol: args.col, shape };
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
export function extendSelectionToToken(id: string, token: TokenHint): void {
  const s = states.get(id);
  if (!s?.selection?.dragging) return;
  const sel = s.selection;
  const anchorOnTokenRow = sel.startRow === token.row;
  const forward = anchorOnTokenRow
    ? sel.startCol <= token.startCol
    : sel.startRow < token.row;
  s.selection = {
    ...sel,
    endRow: token.row,
    endCol: forward ? token.endCol - 1 : token.startCol,
  };
  notify();
}

/**
 * Flip the in-progress drag's shape based on the current Alt-key state.
 * No-op when no drag is active. Used to react to Alt press/release while
 * the mouse is stationary (spec §3.2).
 */
export function setDragAlt(id: string, altKey: boolean): void {
  const s = states.get(id);
  if (!s?.selection?.dragging) return;
  const shape: SelectionShape = altKey ? 'block' : 'linewise';
  if (s.selection.shape === shape) return;
  s.selection = { ...s.selection, shape };
  notify();
}

/**
 * Trigger the "Copied!" flash. The popup reads `copyFlash` and renders a
 * confirmation state; after `durationMs` the flash clears along with the
 * selection, dismissing the popup.
 */
export function flashCopy(id: string, kind: CopyFlashKind, durationMs = 700): void {
  const s = ensure(id);
  s.copyFlash = kind;
  notify();
  setTimeout(() => {
    const current = states.get(id);
    if (!current || current.copyFlash !== kind) return;
    current.copyFlash = null;
    current.selection = null;
    notify();
  }, durationMs);
}

export function setHintToken(id: string, hint: TokenHint | null): void {
  const s = ensure(id);
  if (s.hintToken === null && hint === null) return;
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
