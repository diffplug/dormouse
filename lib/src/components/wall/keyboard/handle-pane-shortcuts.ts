import { acknowledgeSession, dismissSessionAlert, toggleSessionTodo } from '../../../lib/terminal-registry';
import { hasTerminal } from 'dor/commands/types';
import { surfaceKindFromParams } from '../browser-surface';
import { isWorkspaceSelection } from '../wall-types';
import { ARROW_OPPOSITES, isArrowKey, type NavHistoryRef, type WallKeyboardCtx } from './types';

/** Open the terminal context revealed from the pane header's bottom-left
 *  corner. Browser-surface panes carry no `data-pane-header-for`, so the lookup
 *  misses and the caller's key is a consumed no-op — the spec'd behavior for
 *  surfaces with no header context menu. */
function openHeaderContext(ctx: WallKeyboardCtx, id: string): void {
  const header = document.querySelector<HTMLElement>(`[data-pane-header-for="${CSS.escape(id)}"]`);
  if (!header) return;
  const rect = header.getBoundingClientRect();
  ctx.openTerminalContext(id, { x: rect.left, y: rect.bottom });
}

/** Keep aligned with the pane handlers below. Workspace selections consume
 *  these keys; an omitted key returns unhandled without dispatching a pane action.
 *  Pinned by the independent key list in handle-pane-navigation.test.ts. */
const PANE_VERB_KEYS: ReadonlySet<string> = new Set(['Enter', '|', '%', '-', '"', 'k', 'x', ',', 'm', 'd', 't', 'a', 'z', '>']);

/** Command-mode shortcuts acting on the selected pane or Door. The binding
 *  table is `docs/specs/shortcuts.md`; the behavior is `docs/specs/layout.md`. */
export function handlePaneShortcuts(
  e: KeyboardEvent,
  ctx: WallKeyboardCtx,
  navHistory: NavHistoryRef,
): boolean {
  const sid = ctx.selectedIdRef.current;
  // Workspace chrome never dispatches pane verbs.
  if (isWorkspaceSelection(ctx.selectedTypeRef.current)) {
    if (!PANE_VERB_KEYS.has(e.key) && !(isArrowKey(e.key) && (e.metaKey || e.ctrlKey))) return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  // Entering passthrough, from a pane or through its Door, is a human gesture
  // that acknowledges the Session (`docs/specs/alert.md` -> Engagement).
  if (e.key === 'Enter' && sid) {
    e.preventDefault();
    e.stopPropagation();
    if (ctx.selectedTypeRef.current === 'door') {
      const item = ctx.doorsRef.current.find((d) => d.id === sid);
      if (!item) return true;
      ctx.handleReattachRef.current(item);
    } else {
      ctx.enterTerminalMode(sid);
    }
    acknowledgeSession(sid);
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
    if (!sid || ctx.selectedTypeRef.current !== 'pane') return true;

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
    ctx.requestKill(sid);
    return true;
  }

  if (e.key === ',' && sid) {
    e.preventDefault();
    e.stopPropagation();
    // Only a visible terminal header mounts the rename editor. Setting the
    // global rename gate for a Door/browser would strand keyboard dispatch.
    if (ctx.selectedTypeRef.current !== 'pane' || !hasTerminal(surfaceKindFromParams(ctx.nav.paneParams(sid)))) return true;
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
    dismissSessionAlert(sid);
    openHeaderContext(ctx, sid);
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
    openHeaderContext(ctx, sid);
    return true;
  }

  return false;
}
