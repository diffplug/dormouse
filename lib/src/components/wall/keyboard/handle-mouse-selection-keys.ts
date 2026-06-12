import { copyRaw, copyRewrapped, doPaste } from '../../../lib/clipboard';
import { IS_MAC } from '../../../lib/platform';
import {
  extendSelectionToToken,
  flashCopy,
  getMouseSelectionState,
  setSelection as setMouseSelection,
} from '../../../lib/mouse-selection';
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
  if (
    tgt &&
    (tgt.tagName === 'INPUT' ||
      (tgt.tagName === 'TEXTAREA' && !tgt.classList.contains('xterm-helper-textarea')) ||
      tgt.isContentEditable)
  ) {
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
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  if (sel && !sel.dragging && mod && keyLower === 'c') {
    e.preventDefault();
    e.stopImmediatePropagation();
    const rewrapped = e.shiftKey;
    void (rewrapped ? copyRewrapped(sid) : copyRaw(sid)).then(() => {
      flashCopy(sid, rewrapped ? 'rewrapped' : 'raw');
    });
    return true;
  }
  // Accept either Ctrl+V or Cmd+V for paste on all platforms — matches VSCode's
  // terminal paste behavior and the muscle memory of users coming from Linux/Windows.
  // Trade-off: shadows readline's ^V verbatim-insert; not worth surfacing as a
  // setting until someone asks for it.
  if ((e.metaKey || e.ctrlKey) && keyLower === 'v') {
    e.preventDefault();
    e.stopImmediatePropagation();
    void doPaste(sid);
    return true;
  }
  return false;
}

function surfaceTypeForId(ctx: WallKeyboardCtx, id: string): string {
  const panelParams = ctx.apiRef?.current?.getPanel(id)?.params as { surfaceType?: unknown } | undefined;
  if (typeof panelParams?.surfaceType === 'string') return panelParams.surfaceType;
  const door = ctx.doorsRef?.current?.find((candidate) => candidate.id === id);
  const doorType = (door?.params as { surfaceType?: unknown } | undefined)?.surfaceType;
  return typeof doorType === 'string' ? doorType : 'terminal';
}
