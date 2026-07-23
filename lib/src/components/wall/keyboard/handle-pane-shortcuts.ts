import {
  dismissOrToggleAlert,
  getActivity,
  isUntouched,
  toggleSessionTodo,
} from '../../../lib/terminal-registry';
import { randomKillChar } from '../../KillConfirm';
import { ARROW_OPPOSITES, isArrowKey, type NavHistoryRef, type WallKeyboardCtx } from './types';

function findAlertButtonForSession(id: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`[data-alert-button-for="${CSS.escape(id)}"]`);
}

function findPaneHeaderForSession(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-pane-header-for="${CSS.escape(id)}"]`);
}

/**
 * Single-pane shortcuts: Enter (focus/reattach), `|`/`%`/`-`/`"` (split),
 * Cmd-Arrow (swap with neighbor), k/x (kill confirm), `,` (rename),
 * m/d (minimize), t/a (todo/alert toggle), z (zoom + passthrough focus),
 * `>` (open the selected pane's header context menu).
 */
export function handlePaneShortcuts(
  e: KeyboardEvent,
  ctx: WallKeyboardCtx,
  navHistory: NavHistoryRef,
): boolean {
  const sid = ctx.selectedIdRef.current;

  if (e.key === 'Enter' && sid) {
    e.preventDefault();
    e.stopPropagation();
    if (ctx.selectedTypeRef.current === 'door') {
      const item = ctx.doorsRef.current.find((d) => d.id === sid);
      if (item) ctx.handleReattachRef.current(item);
    } else {
      ctx.enterTerminalMode(sid);
    }
    return true;
  }

  if (e.key === '|' || e.key === '%') {
    e.preventDefault();
    e.stopPropagation();
    ctx.wallActionsRef.current.onSplitH(sid, 'keyboard');
    return true;
  }

  if (e.key === '-' || e.key === '"') {
    e.preventDefault();
    e.stopPropagation();
    ctx.wallActionsRef.current.onSplitV(sid, 'keyboard');
    return true;
  }

  if (isArrowKey(e.key) && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    e.stopPropagation();
    if (!sid) return true;

    const dir = e.key;
    const hist = navHistory.current;
    let targetId: string | null = null;
    if (hist && ARROW_OPPOSITES[dir] === hist.direction && ctx.nav.hasPane(hist.fromId)) {
      targetId = hist.fromId;
    } else {
      targetId = ctx.nav.findInDirection(sid, dir);
    }
    if (!targetId) return true;

    // Swap leaf identities (meta follows ids), so the two panes trade places.
    ctx.swapWithNeighbor(sid, targetId);
    ctx.fireEvent({ type: 'move', fromId: sid, toId: targetId });

    // Selection stays on the moved pane, so the breadcrumb records the swap
    // partner — the pane now holding the old slot. The opposite Cmd+Arrow then
    // swaps back exactly, and a plain opposite arrow selects that partner;
    // `fromId: sid` here would make both resolve to the selected pane itself.
    navHistory.current = { direction: dir, fromId: targetId };
    ctx.selectPane(sid);
    return true;
  }

  if ((e.key === 'k' || e.key === 'x') && sid) {
    e.preventDefault();
    e.stopPropagation();
    if (ctx.selectedTypeRef.current === 'door') {
      const item = ctx.doorsRef.current.find((d) => d.id === sid);
      if (item) {
        ctx.handleReattachRef.current(item, {
          enterPassthrough: false,
          afterRestore: isUntouched(sid) ? 'kill-immediately' : 'confirm-kill',
        });
      }
      return true;
    }
    if (isUntouched(sid)) {
      ctx.killPaneImmediately(sid);
      return true;
    }
    const char = randomKillChar();
    ctx.setConfirmKill({ id: sid, char });
    return true;
  }

  if (e.key === ',' && sid) {
    e.preventDefault();
    e.stopPropagation();
    ctx.setRenamingPaneId(sid);
    return true;
  }

  if ((e.key === 'm' || e.key === 'd') && sid) {
    e.preventDefault();
    e.stopPropagation();
    if (ctx.selectedTypeRef.current === 'door') {
      const item = ctx.doorsRef.current.find((d) => d.id === sid);
      if (item) ctx.handleReattachRef.current(item, { enterPassthrough: false });
    } else {
      ctx.minimizePane(sid);
    }
    return true;
  }

  if (e.key === 't' && sid && ctx.selectedTypeRef.current === 'pane') {
    if (ctx.dialogKeyboardActiveRef.current) return true;
    e.preventDefault();
    e.stopPropagation();
    toggleSessionTodo(sid);
    return true;
  }

  if (e.key === 'a' && sid && ctx.selectedTypeRef.current === 'pane') {
    if (ctx.dialogKeyboardActiveRef.current) return true;
    e.preventDefault();
    e.stopPropagation();
    const alertButton = findAlertButtonForSession(sid);
    if (alertButton) alertButton.click();
    else dismissOrToggleAlert(sid, getActivity(sid).status);
    return true;
  }

  if (e.key === 'z' && sid) {
    e.preventDefault();
    e.stopPropagation();
    ctx.wallActionsRef.current.onZoom(sid);
    return true;
  }

  if (e.key === '>' && sid && ctx.selectedTypeRef.current === 'pane') {
    e.preventDefault();
    e.stopPropagation();
    // Reuse the header's own onContextMenu path: dispatch a synthetic
    // contextmenu at the header's bottom-left corner so the menu opens anchored
    // under the header's left edge. Browser-surface panes carry no
    // `data-pane-header-for`, so the lookup misses and the key is a consumed
    // no-op — the spec'd behavior for surfaces with no header context menu.
    const header = findPaneHeaderForSession(sid);
    if (header) {
      const rect = header.getBoundingClientRect();
      header.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left,
        clientY: rect.bottom,
      }));
    }
    return true;
  }

  return false;
}
