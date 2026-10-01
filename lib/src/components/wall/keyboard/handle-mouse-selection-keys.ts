import { doPaste } from '../../../lib/clipboard';
import { cycleCopyFormat, stepCopyScope } from '../../../lib/copy-editor';
import { copySelection, nudgeSelection, openProgramSelection } from '../../../lib/copy-selection';
import { isEditableTarget, isTerminalInputProxy } from '../../../lib/dom';
import {
  extendSelectionToToken,
  getMouseSelectionState,
  isShadowed,
  setSelection as setMouseSelection,
} from '../../../lib/mouse-selection';
import { isWorkspaceSelection } from '../wall-types';
import { hasCopyModifier, hasPasteModifier } from './chords';
import { hasTerminal } from 'dor/commands/types';
import { surfaceKindFromParams, toolFace } from '../browser-surface';
import type { WallKeyboardCtx } from './types';

/** Keys that never dismiss the copy editor: a chord is still being held. */
const MODIFIER_KEYS = new Set(['Shift', 'Meta', 'Control', 'Alt', 'AltGraph', 'CapsLock', 'Fn']);

/**
 * Mouse-selection-aware shortcuts: token extension + Escape during drag, the
 * copy editor's keys over a finalized selection, Cmd-V always. Returns true if
 * handled.
 */
export function handleMouseSelectionKeys(e: KeyboardEvent, ctx: WallKeyboardCtx): boolean {
  // Don't shadow native clipboard ops when focus is inside a real text
  // input (overlay modal, search box, etc.) — let the browser handle
  // copy/paste there. Xterm's hidden helper textarea is the input proxy
  // for the terminal itself, so we keep intercepting its keydowns.
  const tgt = e.target as HTMLElement | null;
  if (isEditableTarget(tgt) && !isTerminalInputProxy(tgt)) {
    return false;
  }

  const sid = ctx.selectedIdRef.current;
  if (!sid) return false;
  if (isWorkspaceSelection(ctx.selectedTypeRef.current)) return false;

  // These chords copy/paste against a terminal's pty and mouse selection.
  // Non-terminal surfaces (agent-browser, iframe) own their clipboard keys —
  // e.g. AgentBrowserPanel forwards cmd-V to the embedded page — so yield.
  const contextTerminal = tgt?.closest?.<HTMLElement>('[data-context-terminal]');
  if (contextTerminal?.dataset.contextTerminal !== sid && !hasActiveTerminal(ctx, sid)) return false;

  const mouseState = getMouseSelectionState(sid);
  const sel = mouseState.selection;

  if (sel?.dragging) {
    if (e.key === 'e' && mouseState.hintToken) {
      e.preventDefault();
      e.stopImmediatePropagation();
      extendSelectionToToken(sid, mouseState.hintToken);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      setMouseSelection(sid, null);
      return true;
    }
    if (e.key !== 'Alt') {
      // Swallow everything except Alt during a drag — Alt is the
      // block-selection modifier and must reach the OS.
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    return true;
  }

  const keyLower = e.key.toLowerCase();
  if (mouseState.copyEditor) {
    if (handleCopyEditorKey(e, sid, keyLower)) return true;
  } else if (isShadowed(mouseState)) {
    // A shadowed program drag (spec §3.8): the copy chord opens the editor
    // over it; any other key belongs to the program, which ends the shadow.
    if (hasCopyModifier(e) && keyLower === 'c') {
      e.preventDefault();
      e.stopImmediatePropagation();
      openProgramSelection(sid);
      return true;
    }
    if (!MODIFIER_KEYS.has(e.key)) setMouseSelection(sid, null);
  }
  // Paste takes either modifier on every platform (see `hasPasteModifier`).
  // Trade-off: shadows readline's ^V verbatim-insert; not worth surfacing as a
  // setting until someone asks for it.
  if (hasPasteModifier(e) && keyLower === 'v') {
    e.preventDefault();
    e.stopImmediatePropagation();
    void doPaste(sid);
    return true;
  }
  return false;
}

/**
 * The copy editor's keys (spec §4.3). Any other key closes it and goes on to
 * the terminal, so typing after a selection still types.
 */
function handleCopyEditorKey(e: KeyboardEvent, sid: string, keyLower: string): boolean {
  const consume = () => {
    e.preventDefault();
    e.stopImmediatePropagation();
    return true;
  };
  const bare = !e.metaKey && !e.ctrlKey && !e.altKey;
  if ((hasCopyModifier(e) && keyLower === 'c') || (bare && e.key === 'Enter' && !e.shiftKey)) {
    void copySelection(sid);
    return consume();
  }
  if (e.key === 'Escape') {
    setMouseSelection(sid, null);
    return consume();
  }
  if (bare && keyLower === 'e') {
    stepCopyScope(sid, e.shiftKey ? -1 : 1);
    return consume();
  }
  if (bare && keyLower === 'f') {
    cycleCopyFormat(sid, e.shiftKey ? -1 : 1);
    return consume();
  }
  if (bare && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    nudgeSelection(sid, e.shiftKey ? 'start' : 'end', e.key === 'ArrowRight' ? 1 : -1);
    return consume();
  }
  if (!MODIFIER_KEYS.has(e.key) && !(hasPasteModifier(e) && keyLower === 'v')) setMouseSelection(sid, null);
  return false;
}

/** `paneParams` reads the store, which holds a Surface's params whether it is a pane
 *  or a Door, so a minimized Surface needs no separate lookup. */
function hasActiveTerminal(ctx: WallKeyboardCtx, id: string): boolean {
  const params = ctx.nav.paneParams(id);
  const kind = surfaceKindFromParams(params);
  if (!hasTerminal(kind)) return false;
  // A tool owns both capabilities, so only its forward half owns keyboard
  // clipboard/selection handling. Pending approval and the second half have no
  // active xterm even though the Surface kind is terminal-capable.
  return kind !== 'tool' || toolFace(params) === 'terminal';
}
