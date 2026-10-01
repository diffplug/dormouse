import { doPaste } from '../../../lib/clipboard';
import { cycleCopyFormat, nudgeCopyEdge, openCopyEditor, stepCopyScope } from '../../../lib/copy-editor';
import { copySelection } from '../../../lib/copy-selection';
import { anchoredTarget, isEditableTarget, isTerminalInputProxy } from '../../../lib/dom';
import {
  extendSelectionToToken,
  getMouseSelectionState,
  isShadowed,
  setSelection as setMouseSelection,
} from '../../../lib/mouse-selection';
import { isWorkspaceSelection } from '../wall-types';
import { hasPasteModifier, isCopyChord } from './chords';
import { hasTerminal } from 'dor/commands/types';
import { surfaceKindFromParams, toolFace } from '../browser-surface';
import type { WallKeyboardCtx } from './types';

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
  // e.g. AgentBrowserPanel forwards cmd-V to the embedded page — so yield. A
  // portaled copy editor counts as where its anchor sits.
  const contextTerminal = (anchoredTarget(tgt) as HTMLElement | null)?.closest?.<HTMLElement>('[data-context-terminal]');
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

  const consume = () => {
    e.preventDefault();
    e.stopImmediatePropagation();
    return true;
  };
  // The copy chord copies from an open editor, or opens one over a shadowed
  // program drag (spec §3.8), in either mode. Any other key the terminal
  // receives closes either one (`writeUserInput`).
  if (isCopyChord(e) && mouseState.copyEditor) {
    void copySelection(sid);
    return consume();
  }
  if (isCopyChord(e) && isShadowed(mouseState)) {
    openCopyEditor(sid);
    return consume();
  }
  if (mouseState.copyEditor && ctx.modeRef.current === 'passthrough' && handleCopyEditorKey(e, sid)) return consume();
  // Paste takes either modifier on every platform (see `hasPasteModifier`).
  // Trade-off: shadows readline's ^V verbatim-insert; not worth surfacing as a
  // setting until someone asks for it.
  if (hasPasteModifier(e) && e.key.toLowerCase() === 'v') {
    void doPaste(sid);
    return consume();
  }
  return false;
}

/** The copy editor's own keys in passthrough (spec §4.3); true if one was
 *  handled. Command mode keeps its keys. */
function handleCopyEditorKey(e: KeyboardEvent, sid: string): boolean {
  if (e.key === 'Escape') {
    setMouseSelection(sid, null);
    return true;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const key = e.key.toLowerCase();
  if (e.key === 'Enter' && !e.shiftKey) void copySelection(sid);
  else if (key === 'e') stepCopyScope(sid, e.shiftKey ? -1 : 1);
  else if (key === 'f') cycleCopyFormat(sid, e.shiftKey ? -1 : 1);
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') nudgeCopyEdge(sid, e.shiftKey ? 'start' : 'end', e.key === 'ArrowRight' ? 1 : -1);
  else return false;
  return true;
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
