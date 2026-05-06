import { findPaneInDirection } from '../../../lib/spatial-nav';
import {
  dismissOrToggleAlert,
  getActivity,
  swapTerminals,
  toggleSessionTodo,
} from '../../../lib/terminal-registry';
import { randomKillChar } from '../../KillConfirm';
import { ARROW_OPPOSITES, isArrowKey, type NavHistoryRef, type WallKeyboardCtx } from './types';
import { swapPanelTitles } from '../dockview-helpers';

function findAlertButtonForSession(id: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`[data-alert-button-for="${CSS.escape(id)}"]`);
}

/**
 * Single-pane shortcuts: Enter (focus/reattach), `|`/`%`/`-`/`"` (split),
 * Cmd-Arrow (swap with neighbor), k/x (kill confirm), `,` (rename),
 * m/d (minimize), t/a (todo/alert toggle), z (zoom).
 */
export function handlePaneShortcuts(
  e: KeyboardEvent,
  ctx: WallKeyboardCtx,
  navHistory: NavHistoryRef,
): boolean {
  const api = ctx.apiRef.current;
  if (!api) return false;
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
    if (hist && ARROW_OPPOSITES[dir] === hist.direction && api.getPanel(hist.fromId)) {
      targetId = hist.fromId;
    } else {
      targetId = findPaneInDirection(sid, dir, api, ctx.paneElements);
    }
    if (!targetId) return true;

    swapTerminals(sid, targetId);
    swapPanelTitles(api, sid, targetId);
    ctx.fireEvent({ type: 'move', fromId: sid, toId: targetId });

    navHistory.current = { direction: dir, fromId: sid };
    ctx.selectPane(targetId);
    return true;
  }

  if ((e.key === 'k' || e.key === 'x') && sid) {
    e.preventDefault();
    e.stopPropagation();
    if (ctx.selectedTypeRef.current === 'door') {
      const item = ctx.doorsRef.current.find((d) => d.id === sid);
      if (item) ctx.handleReattachRef.current(item, { enterPassthrough: false, confirmKill: true });
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

  return false;
}
