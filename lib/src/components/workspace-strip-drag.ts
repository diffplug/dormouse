import { DRAG_THRESHOLD_PX } from './design';
import type { WorkspaceId } from '../lib/session-types';

/**
 * The Workspace strip's reorder gesture: a self-contained pointer controller, so
 * the strip component stays a render of store state
 * (`docs/specs/layout.md` → "Workspaces").
 *
 * It reorders live — the model moves as tab centers are crossed, and the strip
 * re-renders from the store — rather than drawing a floating copy.
 */
export interface StripDragHost {
  /** Workspace ids in strip order, read fresh each frame. */
  order(): WorkspaceId[];
  /** The tab element for a Workspace, or null when it is not rendered. */
  tabElement(id: WorkspaceId): HTMLElement | null;
  /** The strip's own box, for deciding the pointer has left it. */
  stripRect(): DOMRect | null;
  /** Commit a reorder (the store's `moveWorkspace`). */
  move(id: WorkspaceId, toIndex: number): void;
  /** Which Workspace is being dragged, for the dimmed tab. Null ends the drag. */
  setDragging(id: WorkspaceId | null): void;
  /** PR C: the pointer left the window's strip entirely. */
  onDragOutsideWindow?(id: WorkspaceId, point: { clientX: number; clientY: number }): void;
  /** PR C: released over another Window; true means that Window took it. */
  onDropOnOtherWindow?(id: WorkspaceId, point: { clientX: number; clientY: number }): boolean;
}

export interface WorkspaceStripDrag {
  /** Begin tracking a primary-button press on a tab. Below the threshold the
   *  tab's own click behavior (activate / rename) is untouched. */
  press(id: WorkspaceId, event: PointerEvent): void;
  /** Whether the click now being handled is a completed drag's tail rather than
   *  an activate. **One-shot**: the browser sends exactly one click after a
   *  release, and reading this consumes it, so a later keyboard or synthetic
   *  `.click()` on the same tab still activates it. */
  dragged(): boolean;
  dispose(): void;
}

export function createWorkspaceStripDrag(host: StripDragHost): WorkspaceStripDrag {
  let dragId: WorkspaceId | null = null;
  let startIndex = 0;
  let startX = 0;
  let startY = 0;
  let active = false;
  /** Set by the release of a completed drag and consumed by the one click that
   *  follows it. */
  let clickIsDragTail = false;
  /** The tab the press landed on; capture goes here once the drag activates. */
  let pressedOn: HTMLElement | null = null;
  let capturedBy: HTMLElement | null = null;

  function end(restore: boolean): void {
    if (dragId === null) return;
    if (restore) host.move(dragId, startIndex);
    clickIsDragTail = active;
    active = false;
    // jsdom (and a gesture that never reached the threshold) throws here; the
    // gesture is over either way.
    try { capturedBy?.releasePointerCapture?.(pointerId); } catch { /* not captured */ }
    capturedBy = null;
    pressedOn = null;
    dragId = null;
    host.setDragging(null);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('keydown', onKeyDown, true);
  }

  let pointerId = -1;

  function onPointerMove(event: PointerEvent): void {
    if (dragId === null || event.pointerId !== pointerId) return;
    if (!active) {
      if (Math.hypot(event.clientX - startX, event.clientY - startY) < DRAG_THRESHOLD_PX) return;
      active = true;
      host.setDragging(dragId);
      // Captured only NOW, never on the press: a captured pointer retargets the
      // following `click` to the capture element, which would swallow the
      // activate button's own click on every plain tab press. The capture goes
      // on the TAB, which is what the pointer is dragging; React 19's synthetic
      // event is dispatched from the root container, so its `nativeEvent`
      // reports that container as the target instead.
      try { pressedOn?.setPointerCapture?.(pointerId); capturedBy = pressedOn; } catch { capturedBy = null; }
    }
    const order = host.order();
    const from = order.indexOf(dragId);
    if (from === -1) return;
    // Swap with the neighbor whose CENTER the pointer has crossed: the tab it is
    // over would flicker back and forth as the dragged tab takes its place.
    for (let index = 0; index < order.length; index += 1) {
      if (index === from) continue;
      const rect = host.tabElement(order[index])?.getBoundingClientRect();
      if (!rect) continue;
      const center = rect.left + rect.width / 2;
      if ((index < from && event.clientX < center) || (index > from && event.clientX > center)) {
        host.move(dragId, index);
        return;
      }
    }
    const strip = host.stripRect();
    if (host.onDragOutsideWindow && strip
      && (event.clientX < strip.left || event.clientX > strip.right
        || event.clientY < strip.top || event.clientY > strip.bottom)) {
      host.onDragOutsideWindow(dragId, { clientX: event.clientX, clientY: event.clientY });
    }
  }

  function onPointerUp(event: PointerEvent): void {
    if (dragId === null || event.pointerId !== pointerId) return;
    // The order is already committed live, so a release inside this strip has
    // nothing left to do; PR C's hook is what a release over another Window uses.
    if (active) host.onDropOnOtherWindow?.(dragId, { clientX: event.clientX, clientY: event.clientY });
    end(false);
  }

  function onPointerCancel(event: PointerEvent): void {
    if (event.pointerId !== pointerId) return;
    end(active);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || dragId === null) return;
    event.preventDefault();
    event.stopPropagation();
    end(active);
  }

  return {
    press(id, event) {
      if (event.button !== 0 || dragId !== null) return;
      dragId = id;
      pointerId = event.pointerId;
      startIndex = host.order().indexOf(id);
      startX = event.clientX;
      startY = event.clientY;
      active = false;
      clickIsDragTail = false;
      pressedOn = host.tabElement(id);
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerCancel);
      window.addEventListener('keydown', onKeyDown, true);
    },
    dragged: () => {
      const tail = clickIsDragTail;
      clickIsDragTail = false;
      return tail;
    },
    dispose: () => end(false),
  };
}
