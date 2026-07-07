import { ARROW_OPPOSITES, isArrowKey, type NavHistoryRef, type WallKeyboardCtx } from './types';

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
  if (!ctx.nav.ready() || !sid) return true;

  const dir = e.key;
  const currentType = ctx.selectedTypeRef.current;
  const currentDoors = ctx.doorsRef.current;

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
    ctx.selectDoor(currentDoors[0].id);
  }
  return true;
}
