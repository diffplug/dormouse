// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceStripDrag } from './workspace-strip-drag';

/**
 * The strip's pointer controller, at the one boundary the host cares about:
 * when the pointer leaves the strip, and when it comes back
 * (`docs/specs/standalone.md` → "Dragging a Workspace between windows").
 */

const STRIP = { left: 0, right: 400, top: 0, bottom: 24 } as DOMRect;

function pointer(type: string, x: number, y: number): PointerEvent {
  const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }) as unknown as PointerEvent;
  Object.defineProperty(event, 'pointerId', { value: 1 });
  Object.defineProperty(event, 'button', { value: 0 });
  return event;
}

let drag: ReturnType<typeof createWorkspaceStripDrag>;
const outside = vi.fn();
const backInside = vi.fn();

beforeEach(() => {
  outside.mockClear();
  backInside.mockClear();
  const tab = document.createElement('div');
  tab.getBoundingClientRect = () => ({ left: 0, right: 100, width: 100 }) as DOMRect;
  document.body.replaceChildren(tab);
  drag = createWorkspaceStripDrag({
    order: () => ['w1'],
    tabElement: () => tab,
    stripRect: () => STRIP,
    move: () => {},
    setDragging: () => {},
    onDragOutsideWindow: outside,
    onDragBackInsideStrip: backInside,
  });
  drag.press('w1', pointer('pointerdown', 10, 10));
});

afterEach(() => drag.dispose());

describe('crossing the strip edge', () => {
  it('reports the pointer leaving, and reports it coming back exactly once', () => {
    // Past the drag threshold, still over the strip.
    window.dispatchEvent(pointer('pointermove', 60, 10));
    expect(outside).not.toHaveBeenCalled();
    expect(backInside).not.toHaveBeenCalled();

    window.dispatchEvent(pointer('pointermove', 900, 300));
    expect(outside).toHaveBeenCalledWith({ clientX: 900, clientY: 300 });

    // Back over its own strip: the live reorder takes the gesture back, and a
    // caret the host lit in another window is stale from here.
    window.dispatchEvent(pointer('pointermove', 120, 10));
    expect(backInside).toHaveBeenCalledTimes(1);
    // Staying inside is not a fresh crossing.
    window.dispatchEvent(pointer('pointermove', 140, 10));
    expect(backInside).toHaveBeenCalledTimes(1);

    // Out and back again is.
    window.dispatchEvent(pointer('pointermove', 900, 300));
    window.dispatchEvent(pointer('pointermove', 160, 10));
    expect(backInside).toHaveBeenCalledTimes(2);
  });

  it('reports leaving even on a move that also reorders', () => {
    // The reorder scan returns as soon as it moves a tab, and the host still
    // has to hear that the pointer is outside.
    window.dispatchEvent(pointer('pointermove', 900, 300));
    expect(outside).toHaveBeenCalledTimes(1);
  });
});
