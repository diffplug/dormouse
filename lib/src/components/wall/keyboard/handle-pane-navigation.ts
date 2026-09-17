import { ARROW_OPPOSITES, isArrowKey, type NavHistoryRef, type WallKeyboardCtx } from './types';
import { getWorkspacesSnapshot } from '../../../lib/workspace-store';

/**
 * Plain arrow navigation: across panes (tiled), or across doors (in the
 * baseboard), with backtracking via the NavHistoryRef.
 */
export function handlePaneNavigation(
  e: KeyboardEvent,
  ctx: WallKeyboardCtx,
  navHistory: NavHistoryRef,
): boolean {
  if (!isArrowKey(e.key) || e.metaKey || e.ctrlKey) {
    return false;
  }
  e.preventDefault();
  e.stopPropagation();

  const sid = ctx.selectedIdRef.current;
  if (!sid) return true;

  const dir = e.key;
  const currentType = ctx.selectedTypeRef.current;
  const currentDoors = ctx.doorsRef.current;

  if (currentType === 'workspace' || currentType === 'workspace-new') {
    navHistory.current = null;
    if (dir === 'ArrowDown') ctx.returnToPane();
    else if (dir === 'ArrowLeft' || dir === 'ArrowRight') {
      const ids = [...getWorkspacesSnapshot().workspaces.map(workspace => workspace.id), null];
      const index = ids.indexOf(currentType === 'workspace-new' ? null : sid);
      const next = index + (dir === 'ArrowLeft' ? -1 : 1);
      if (index >= 0 && next >= 0 && next < ids.length) ctx.selectWorkspace(ids[next]);
    }
    return true;
  }

  if (currentType === 'door') {
    if (dir === 'ArrowUp') {
      const panes = ctx.nav.panes();
      if (panes.length > 0) ctx.selectPane(panes[panes.length - 1]);
      return true;
    }
    const doorIdx = currentDoors.findIndex((d) => d.id === sid);
    if (dir === 'ArrowLeft' && doorIdx > 0) ctx.selectDoor(currentDoors[doorIdx - 1].id);
    else if (dir === 'ArrowRight' && doorIdx < currentDoors.length - 1) ctx.selectDoor(currentDoors[doorIdx + 1].id);
    return true;
  }

  const hist = navHistory.current;
  if (hist && ARROW_OPPOSITES[dir] === hist.direction && ctx.nav.hasPane(hist.fromId)) {
    navHistory.current = { direction: dir, fromId: sid };
    ctx.selectPane(hist.fromId);
    return true;
  }

  const targetId = ctx.nav.findInDirection(sid, dir);
  if (targetId) {
    navHistory.current = { direction: dir, fromId: sid };
    ctx.selectPane(targetId);
  } else if (dir === 'ArrowDown' && currentDoors.length > 0) {
    navHistory.current = null;
    ctx.selectDoor(currentDoors[0].id);
  } else if (dir === 'ArrowUp' && ctx.workspaceId !== undefined) {
    navHistory.current = null;
    ctx.selectWorkspace(getWorkspacesSnapshot().activeId);
  }
  return true;
}
