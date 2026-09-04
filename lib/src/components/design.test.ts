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
  MODAL_OVERLAY_INSET,
  OVERLAY_MAX_HEIGHT,
  OVERLAY_MAX_HEIGHT_CSS,
  OVERLAY_MAX_HEIGHT_VAR,
} from './design';
import { OVERLAY_VIEWPORT_MARGIN_PX } from '../lib/ui-geometry';

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
// Same reason as above: Tailwind scans source statically, so the viewport caps
// are hand-written literals. These tie them back to the constants they are
// derived from — `clampOverlayPosition`'s margin, and the modal overlay's own
// inset — so a change to either can't silently leave the cap behind.
describe('viewport-bounded overlay caps', () => {
  it('the popover cap matches clampOverlayPosition\'s viewport margin', () => {
    expect(OVERLAY_VIEWPORT_MARGIN_PX).toBe(12);
    expect(OVERLAY_MAX_HEIGHT.popover).toContain(`calc(100dvh-${OVERLAY_VIEWPORT_MARGIN_PX * 2}px)`);
  });

  it('the inline popover cap says the same thing as the class', () => {
    // Two spellings of one cap: Tailwind needs a whole literal, an inline style
    // does not. Only the class is hand-written, so pin it against the assembled
    // value rather than re-spelling the assembly.
    expect(OVERLAY_MAX_HEIGHT.popover).toBe(
      `max-h-[${OVERLAY_MAX_HEIGHT_CSS.popover.replaceAll(' ', '')}]`,
    );
  });

  it('the modal cap matches the overlay inset it sits inside', () => {
    // `py-6` is 1.5rem a side, so the surface gives up 3rem of viewport.
    expect(MODAL_OVERLAY_INSET).toContain('py-6');
    expect(OVERLAY_MAX_HEIGHT.modal).toContain('calc(100dvh-3rem)');
  });

  it('each cap is overridable through its own custom property', () => {
    // The escape hatch stories use to snapshot the short-viewport layout. One
    // property per kind: the popover renders *inside* the modal surface in the
    // Settings dialog, and custom properties inherit, so a shared knob would
    // cap the dialog whenever a caller narrowed the dropdown.
    expect(OVERLAY_MAX_HEIGHT.modal).toContain(`var(${OVERLAY_MAX_HEIGHT_VAR.modal},`);
    expect(OVERLAY_MAX_HEIGHT.popover).toContain(`var(${OVERLAY_MAX_HEIGHT_VAR.popover},`);
    expect(OVERLAY_MAX_HEIGHT_VAR.modal).not.toBe(OVERLAY_MAX_HEIGHT_VAR.popover);
  });
});

describe('focus-ring motion timing', () => {
  it('header crossfade duration + curve track FOCUS_MOTION_MS', () => {
    expect(FOCUS_MOTION_MS).toBe(220);
    expect(HEADER_PALETTE_TRANSITION_CLASS).toContain(`duration-[${FOCUS_MOTION_MS}ms]`);
    expect(HEADER_PALETTE_TRANSITION_CLASS).toContain('ease-[cubic-bezier(0.22,1,0.36,1)]');
    // Reduced motion nulls the crossfade, mirroring the ring's snap gate.
    expect(HEADER_PALETTE_TRANSITION_CLASS).toContain('motion-reduce:transition-none');
  });
});
