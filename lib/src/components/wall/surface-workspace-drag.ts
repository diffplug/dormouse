import { getWorkspaceUiSnapshot } from '../../lib/workspace-ui-store';
import { wallHandleOwning } from './wall-handles';
import { requestSurfaceMove } from './surface-move';

/** A pane press owns this path; only a tab press owns reorder/tear-out. */
export interface SurfaceWorkspaceDrag {
  hover(id: string, x: number, y: number): boolean;
  drop(id: string, x: number, y: number): boolean;
  end(): void;
}

let highlighted: HTMLElement | null = null;
function clear(): void {
  highlighted?.removeAttribute('data-surface-drop');
  highlighted = null;
}
function targetAt(x: number, y: number): HTMLElement | null {
  const strip = document.querySelector<HTMLElement>('[data-workspace-strip]');
  if (!strip) return null;
  const contains = (element: HTMLElement) => {
    const r = element.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };
  if (!contains(strip)) return null;
  return [...strip.querySelectorAll<HTMLElement>('[data-workspace-tab], [data-workspace-new]')].find(contains) ?? strip;
}
function eligible(id: string, target: HTMLElement): boolean {
  const source = wallHandleOwning(id);
  const ui = getWorkspaceUiSnapshot();
  return !!source?.canMoveSurfaces && !ui.pendingSurfaceMove && !ui.pendingMove && !ui.pendingClose
    && (target.hasAttribute('data-workspace-new') ? source.surfaceIds().length > 1 : !!target.dataset.workspaceTab && target.dataset.workspaceTab !== source.workspaceId);
}
export const surfaceWorkspaceDrag: SurfaceWorkspaceDrag = {
  hover(id, x, y) {
    clear();
    const target = targetAt(x, y);
    if (!target) return false;
    if (eligible(id, target)) { highlighted = target; target.setAttribute('data-surface-drop', ''); }
    return true; // Strip gaps and disabled targets consume the drop too.
  },
  drop(id, x, y) {
    const target = targetAt(x, y);
    clear();
    if (!target) return false;
    if (eligible(id, target)) requestSurfaceMove(id, target.hasAttribute('data-workspace-new') ? { new: true } : { workspace: target.dataset.workspaceTab! });
    return true;
  },
  end: clear,
};
