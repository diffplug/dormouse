import { getWorkspaceUiSnapshot } from '../../lib/workspace-ui-store';
import { workspaceStripElement, workspaceTabElement, workspaceTabElements } from '../workspace-tab-elements';
import { wallHandleOwning } from './wall-handles';
import { requestSurfaceMove } from './surface-move';

/** A pane press owns this path; only a tab press owns reorder/tear-out. */
export interface SurfaceWorkspaceDrag {
  hover(id: string, x: number, y: number): boolean;
  drop(id: string, x: number, y: number): boolean;
  end(): void;
}

type Measured = { strip: HTMLElement; stripRect: DOMRect; targets: [HTMLElement, DOMRect][] };
// The strip cannot reorder under a pane drag, so one measurement serves the gesture.
let measured: Measured | null | undefined;
let hovered: HTMLElement | null = null;
let highlighted: HTMLElement | null = null;

const inside = (r: DOMRect, x: number, y: number) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
function measure(): Measured | null {
  const strip = workspaceStripElement();
  if (!strip) return null;
  const elements = [...workspaceTabElements(), workspaceTabElement(null)].filter((element): element is HTMLElement => element !== null);
  return { strip, stripRect: strip.getBoundingClientRect(), targets: elements.map(element => [element, element.getBoundingClientRect()]) };
}
/** The tab or + under the pointer, the strip itself over a gap, or null off the strip. */
function targetAt(x: number, y: number): HTMLElement | null {
  if (measured === undefined) measured = measure();
  if (!measured || !inside(measured.stripRect, x, y)) return null;
  return measured.targets.find(([, rect]) => inside(rect, x, y))?.[0] ?? measured.strip;
}
function eligible(id: string, target: HTMLElement): boolean {
  const source = wallHandleOwning(id);
  const ui = getWorkspaceUiSnapshot();
  return !!source?.canMoveSurfaces && !ui.pendingSurfaceMove && !ui.pendingMove && !ui.pendingClose
    && (target.hasAttribute('data-workspace-new') ? source.surfaceIds().length > 1 : !!target.dataset.workspaceTab && target.dataset.workspaceTab !== source.workspaceId);
}
function highlight(target: HTMLElement | null): void {
  if (target === highlighted) return;
  highlighted?.removeAttribute('data-surface-drop');
  target?.setAttribute('data-surface-drop', '');
  highlighted = target;
}
function end(): void {
  highlight(null);
  hovered = null;
  measured = undefined;
}
export const surfaceWorkspaceDrag: SurfaceWorkspaceDrag = {
  hover(id, x, y) {
    const target = targetAt(x, y);
    if (target !== hovered) {
      hovered = target;
      highlight(target && eligible(id, target) ? target : null);
    }
    return target !== null; // Strip gaps and disabled targets consume the drop too.
  },
  drop(id, x, y) {
    const target = targetAt(x, y);
    end();
    if (!target) return false;
    if (eligible(id, target)) requestSurfaceMove(id, target.hasAttribute('data-workspace-new') ? { new: true } : { workspace: target.dataset.workspaceTab! });
    return true;
  },
  end,
};
