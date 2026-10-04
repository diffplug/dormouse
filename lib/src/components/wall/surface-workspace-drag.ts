import { workspaceStripAreas, workspaceTabElement, workspaceTabElements } from '../workspace-tab-elements';
import { wallHandleOwning } from './wall-handles';
import { requestSurfaceMove, surfaceMoveRefusal } from './surface-move';

/** A pane press owns this path; only a tab press owns reorder/tear-out. */
export interface SurfaceWorkspaceDrag {
  hover(id: string, x: number, y: number): boolean;
  drop(id: string, x: number, y: number): boolean;
  end(): void;
}

let highlighted: HTMLElement | null = null;

const inside = (r: DOMRect, x: number, y: number) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
/** Read live bounds: titles, tab scrolling and CLI reorders can change them mid-drag. */
function targetAt(x: number, y: number): HTMLElement | null {
  const area = workspaceStripAreas().find(candidate => inside(candidate.getBoundingClientRect(), x, y));
  if (!area) return null;
  const targets = [...workspaceTabElements(), workspaceTabElement(null)];
  return targets.find(target => target && inside(target.getBoundingClientRect(), x, y)) ?? area;
}
/** The drop's destination, or null for the strip's gaps. */
function destinationOf(target: HTMLElement): { workspace: string } | { new: true } | null {
  if (target.hasAttribute('data-workspace-new')) return { new: true };
  return target.dataset.workspaceTab ? { workspace: target.dataset.workspaceTab } : null;
}
function eligible(id: string, target: HTMLElement): boolean {
  const destination = destinationOf(target);
  return !!destination && !surfaceMoveRefusal(wallHandleOwning(id), destination);
}
function highlight(target: HTMLElement | null): void {
  if (target === highlighted) return;
  highlighted?.removeAttribute('data-surface-drop');
  target?.setAttribute('data-surface-drop', '');
  highlighted = target;
}
function end(): void {
  highlight(null);
}
export const surfaceWorkspaceDrag: SurfaceWorkspaceDrag = {
  hover(id, x, y) {
    const target = targetAt(x, y);
    highlight(target && eligible(id, target) ? target : null);
    return target !== null; // Strip gaps and disabled targets consume the drop too.
  },
  drop(id, x, y) {
    const target = targetAt(x, y);
    end();
    if (!target) return false;
    if (eligible(id, target)) requestSurfaceMove(id, destinationOf(target)!);
    return true;
  },
  end,
};
