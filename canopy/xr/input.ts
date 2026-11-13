import type { Terminal } from '@xterm/xterm';
import { Vector3, type Object3D } from 'three';

export interface Cell {
  col: number;
  row: number;
}

/**
 * Where a point in a pane's local frame (a centered `width` × `height` plane, +y up) falls on the
 * terminal, as fractions of its width and height from the top-left, clamped to the edges so a
 * captured drag past the pane keeps tracking.
 */
export function paneFraction(local: { x: number; y: number }, width: number, height: number): { fx: number; fy: number } {
  const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
  return { fx: clamp01(local.x / width + 0.5), fy: clamp01(0.5 - local.y / height) };
}

/** The viewport cell under a pane fraction. */
export function cellAt({ fx, fy }: { fx: number; fy: number }, cols: number, rows: number): Cell {
  return { col: Math.min(cols - 1, Math.floor(fx * cols)), row: Math.min(rows - 1, Math.floor(fy * rows)) };
}

/** The pointer-event surface @pmndrs/pointer-events dispatches on a `RayInteractable`'s Object3D. */
interface PointerHit {
  point: Vector3;
  pointerId: number;
  target: { setPointerCapture?(id: number): void; releasePointerCapture?(id: number): void };
}

export interface PaneInputEvents {
  /** Every ray move, press, and release over the pane, with the cell it maps to. */
  onPointer?(kind: 'move' | 'down' | 'up', cell: Cell): void;
}

/**
 * Gives `term` a mouse driven by the controller rays hitting `pane`: each ray event is replayed as
 * the DOM mouse event xterm.js listens for, at the hit's exact point on the terminal's screen
 * element. xterm then does what a desktop mouse does — selection (drag, double-click word, triple
 * click line) when the program has not asked for the mouse, mouse reports when it has — and the
 * demo carries no selection or protocol logic of its own.
 *
 * One press at a time: every controller's ray reports hover over the pane, so after a press only the
 * pressing pointer's events count, and pointer capture keeps its drag alive off the pane's edge.
 */
export function attachPaneInput(
  pane: Object3D,
  size: () => { width: number; height: number },
  term: Terminal,
  events: PaneInputEvents = {},
): () => void {
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
  if (!screen) throw new Error('attachPaneInput needs an opened terminal');

  let pressing: number | null = null;
  let lastDown = { time: 0, col: -1, row: -1, count: 0 };
  const local = new Vector3();

  const fractionOf = (e: PointerHit) => {
    pane.worldToLocal(local.copy(e.point));
    const { width, height } = size();
    return paneFraction(local, width, height);
  };
  const replay = (type: 'mousemove' | 'mousedown' | 'mouseup', e: PointerHit, detail = 0) => {
    const fraction = fractionOf(e);
    const rect = screen.getBoundingClientRect();
    screen.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        detail,
        button: 0,
        buttons: pressing === null ? 0 : 1,
        clientX: rect.left + fraction.fx * rect.width,
        clientY: rect.top + fraction.fy * rect.height,
      }),
    );
    return cellAt(fraction, term.cols, term.rows);
  };

  const down = (e: PointerHit) => {
    if (pressing !== null) return;
    e.target.setPointerCapture?.(e.pointerId);
    pressing = e.pointerId;
    term.focus();
    // xterm reads the click count from `detail`, which a synthetic event must supply itself.
    const now = performance.now();
    const cell = cellAt(fractionOf(e), term.cols, term.rows);
    const repeat = now - lastDown.time < 400 && cell.col === lastDown.col && cell.row === lastDown.row;
    lastDown = { time: now, ...cell, count: repeat ? lastDown.count + 1 : 1 };
    events.onPointer?.('down', replay('mousedown', e, lastDown.count));
  };
  const move = (e: PointerHit) => {
    if (pressing !== null && e.pointerId !== pressing) return;
    events.onPointer?.('move', replay('mousemove', e));
  };
  const up = (e: PointerHit) => {
    if (e.pointerId !== pressing) return;
    e.target.releasePointerCapture?.(e.pointerId);
    pressing = null;
    events.onPointer?.('up', replay('mouseup', e, lastDown.count));
  };

  // three's typed event map has no pointer events; @pmndrs/pointer-events dispatches them untyped.
  const target = pane as unknown as {
    addEventListener(type: string, fn: (e: PointerHit) => void): void;
    removeEventListener(type: string, fn: (e: PointerHit) => void): void;
  };
  target.addEventListener('pointerdown', down);
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', up);
  return () => {
    target.removeEventListener('pointerdown', down);
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', up);
  };
}
