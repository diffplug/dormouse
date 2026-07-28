import { describe, expect, it } from 'vitest';
import {
  TERMINAL_BORDER_RADIUS_PX,
  TERMINAL_TOP_RADIUS_CLASS,
  TERMINAL_BOTTOM_RADIUS_CLASS,
  TERMINAL_SELECTION_BORDER_RADIUS,
  DOOR_SELECTION_BORDER_RADIUS,
  PANE_GUTTER_PX,
  SELECTION_RING_INFLATE_PX,
  PANE_SELECTION_RING_RADIUS_PX,
  PANE_SELECTION_RING_BORDER_RADIUS,
} from './design';

// The terminal radius is consumed by SVG path math (px), Tailwind classes,
// and inline border-radius styles. They are all derived from one source —
// these checks fail loudly if a future edit decouples them.
describe('terminal radius constants', () => {
  it('px and rem agree (1rem = 16px)', () => {
    const remFromString = parseFloat(TERMINAL_SELECTION_BORDER_RADIUS);
    expect(TERMINAL_BORDER_RADIUS_PX).toBe(remFromString * 16);
  });

  it('top/bottom Tailwind classes use the same radius step', () => {
    const topStep = TERMINAL_TOP_RADIUS_CLASS.replace('rounded-t-', '');
    const bottomStep = TERMINAL_BOTTOM_RADIUS_CLASS.replace('rounded-b-', '');
    expect(topStep).toBe(bottomStep);
  });

  it('door selection radius rounds top corners only', () => {
    expect(DOOR_SELECTION_BORDER_RADIUS).toBe(`${TERMINAL_SELECTION_BORDER_RADIUS} ${TERMINAL_SELECTION_BORDER_RADIUS} 0 0`);
  });

  // Concentric-corners rule: the pane focus ring draws SELECTION_RING_INFLATE_PX
  // outside the pane edge, so its radius must be the pane radius plus that
  // offset — nested corners share a center; the inner radius never tightens.
  it('pane focus ring radius is concentric with the pane corner', () => {
    expect(PANE_SELECTION_RING_RADIUS_PX).toBe(TERMINAL_BORDER_RADIUS_PX + SELECTION_RING_INFLATE_PX);
    expect(PANE_SELECTION_RING_BORDER_RADIUS).toBe(`${PANE_SELECTION_RING_RADIUS_PX}px`);
  });

  // The 1px passthrough border draws just inside the inflated rect, spanning
  // [INFLATE-1, INFLATE] from the pane edge. Centering it in the gutter needs
  // its middle (INFLATE - 0.5) on the gutter's centerline — which only lands
  // on whole pixels because the gutter is odd.
  it('pane focus ring is centered in the gutter, on whole pixels', () => {
    expect(SELECTION_RING_INFLATE_PX - 0.5).toBe(PANE_GUTTER_PX / 2);
    expect(PANE_GUTTER_PX % 2).toBe(1);
    expect(Number.isInteger(SELECTION_RING_INFLATE_PX)).toBe(true);
  });
});
