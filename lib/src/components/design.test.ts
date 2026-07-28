import { describe, expect, it } from 'vitest';
import {
  TERMINAL_BORDER_RADIUS_PX,
  TERMINAL_TOP_RADIUS_CLASS,
  TERMINAL_BOTTOM_RADIUS_CLASS,
  TERMINAL_SELECTION_BORDER_RADIUS,
  PANE_GUTTER_PX,
  SELECTION_RING_INFLATE_PX,
  PANE_SELECTION_RING_RADIUS_PX,
  FOCUS_MOTION_MS,
  HEADER_PALETTE_TRANSITION_CLASS,
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

  // Concentric-corners rule: the pane focus ring draws SELECTION_RING_INFLATE_PX
  // outside the pane edge, so its radius must be the pane radius plus that
  // offset — nested corners share a center; the inner radius never tightens.
  it('pane focus ring radius is concentric with the pane corner', () => {
    expect(PANE_SELECTION_RING_RADIUS_PX).toBe(TERMINAL_BORDER_RADIUS_PX + SELECTION_RING_INFLATE_PX);
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

// The header palette crossfade must resolve on the same timing as the focus
// ring's travel. Tailwind can't build a class from a JS constant, so the class
// is a hand-written literal — this ties it back to FOCUS_MOTION_MS and the house
// curve so the two can't silently drift apart.
describe('focus-ring motion timing', () => {
  it('header crossfade duration + curve track FOCUS_MOTION_MS', () => {
    expect(FOCUS_MOTION_MS).toBe(220);
    expect(HEADER_PALETTE_TRANSITION_CLASS).toContain(`duration-[${FOCUS_MOTION_MS}ms]`);
    expect(HEADER_PALETTE_TRANSITION_CLASS).toContain('ease-[cubic-bezier(0.22,1,0.36,1)]');
    // Reduced motion nulls the crossfade, mirroring the ring's snap gate.
    expect(HEADER_PALETTE_TRANSITION_CLASS).toContain('motion-reduce:transition-none');
  });
});
