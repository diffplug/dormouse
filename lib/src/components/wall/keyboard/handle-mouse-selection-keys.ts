import { copyRaw, copyRewrapped, doPaste } from '../../../lib/clipboard';
import { isEditableTarget, isTerminalInputProxy } from '../../../lib/dom';
import {
  extendSelectionToToken,
  flashCopy,
  getMouseSelectionState,
  setSelection as setMouseSelection,
} from '../../../lib/mouse-selection';
import { hasCopyModifier, hasPasteModifier } from './chords';
import type { WallKeyboardCtx } from './types';

/**
 * Mouse-selection-aware shortcuts: token extension + Escape during drag,
 * Cmd-C / Cmd-Shift-C / Cmd-V outside drag. Returns true if handled.
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

  // These chords copy/paste against a terminal's pty and mouse selection.
  // Non-terminal surfaces (agent-browser, iframe) own their clipboard keys —
  // e.g. AgentBrowserPanel forwards cmd-V to the embedded page — so yield.
  if (surfaceTypeForId(ctx, sid) !== 'terminal') return false;

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
  if (sel && !sel.dragging && hasCopyModifier(e) && keyLower === 'c') {
    e.preventDefault();
    e.stopImmediatePropagation();
    const rewrapped = e.shiftKey;
    void (rewrapped ? copyRewrapped(sid) : copyRaw(sid)).then(() => {
      flashCopy(sid, rewrapped ? 'rewrapped' : 'raw');
    });
    return true;
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

/** `paneParams` reads the store, which holds a Surface's params whether it is a pane
 *  or a Door, so a minimized Surface needs no separate lookup. */
function surfaceTypeForId(ctx: WallKeyboardCtx, id: string): string {
  const params = ctx.nav.paneParams(id) as { surfaceType?: unknown } | undefined;
  return typeof params?.surfaceType === 'string' ? params.surfaceType : 'terminal';
}
