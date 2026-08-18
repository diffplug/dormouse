/** Centralized tuning parameters for graphical feel.
 *  Adjust values here rather than scattering magic numbers across components. */
export const cfg = {
  marchingAnts: {
    /** Target segment length (dash + gap) in px. Smaller = more, tinier dashes. */
    segLen: 10,
    /** Fraction of each segment that is a visible dash (remainder is gap). */
    dashFraction: 0.6,
    /** Seconds for one full dash-gap cycle. */
    cycleDuration: 0.4,
    /** Stroke width in px. */
    strokeWidth: 2,
    /** When true, animation is frozen at T=0 (for deterministic Chromatic snapshots). */
    paused: false,
  },
  alert: {
    /** ms — enough elapsed time to treat ongoing output as a possible busy transition. */
    busyCandidateGap: 1_500,
    /** ms — additional evidence window before calling the Session BUSY. */
    busyConfirmGap: 500,
    /** ms — silence after BUSY before suspecting completion. */
    mightNeedAttention: 2_000,
    /** ms — additional silence before confirming NEEDS_ATTENTION. */
    needsAttentionConfirm: 3_000,
    /** ms — ignore resize redraw noise. */
    resizeDebounce: 500,
    /** ms — attention idle expiry. How long before "looking at this pane" wears off. */
    userAttention: 15_000,
    /** When true, the ALERT_RINGING bell-ring animation is frozen at T=0 (for deterministic Chromatic snapshots). */
    ringingPaused: false,
  },
  terminal: {
    /** xterm cursor blink. Disabled under Chromatic so the cursor renders as a
     *  stable solid block rather than being captured mid-blink (non-deterministic). */
    cursorBlink: true,
    /** Render terminals through `@xterm/addon-webgl` instead of xterm's DOM
     *  renderer. Disabled under Chromatic: the GPU path paints into a `<canvas>`,
     *  which snapshots as an opaque bitmap subject to driver differences, whereas
     *  the DOM renderer emits styled spans that diff deterministically. Turning it
     *  off also gives a way to A/B the renderer when diagnosing a rendering bug
     *  (`docs/specs/layout.md` → Renderer). */
    webglRenderer: true,
  },
  layout: {
    /** When false, Lath pane geometry changes (split / restore / kill / drag) apply
     *  instantly with no tween. Disabled under Chromatic: a mid-tween split resizes
     *  panes through many transient widths (briefly near-zero), and xterm's DOM
     *  renderer can latch onto one of those frames and leave a pane painted blank or
     *  clipped (`user@dormouse:~$` → `user@do`) even after the geometry settles.
     *  Snapping straight to the final geometry removes that whole race. */
    animate: true,
  },
  focusRing: {
    // Directional motion smear while the focus ring travels between panes, drawn as
    // a layer of bands behind the ring. A line smears only by moving ACROSS itself,
    // so each of the four edges is driven by its own perpendicular speed (px/ms) and
    // the four are independent — moving between panes flush at the top, the top edge
    // never smears while the bottom edge does. A settled or reduced-motion ring has
    // null speeds, so it never smears (see WorkspaceSelectionOverlay).
    /** Edge speed (px/ms) at which the smear is fully developed — the knob that sets
     *  the effect's SHAPE over a travel. Below it, extent and intensity scale
     *  linearly with speed; at or above it, both sit at their ceilings. The house
     *  ease-out peaks around 16 px/ms on a full-width pane travel and averages ~3.7,
     *  so 8 holds full smear through the fast opening and then decays with real
     *  velocity. Lower it for a more uniform blur, raise it to make blur track speed
     *  more closely (short hops then smear noticeably less than long jumps). */
    smearFullSpeed: 8,
    /** How far a smear band reaches at full speed (px) — the effect's EXTENT. 12px on
     *  the 2px ants stroke is a 6x spread. Independent of intensity: see
     *  smearPeakAlpha, and the note in WorkspaceSelectionOverlay on why this is not
     *  tied to alpha by ink conservation. */
    smearMaxPx: 12,
    /** Alpha a band reaches at full speed — the effect's INTENSITY. Kept well under 1
     *  so the smear reads as motion behind the ring rather than as a second, fatter
     *  ring; raise it (not smearMaxPx) to make the blur punchier without extending
     *  its reach. */
    smearPeakAlpha: 1 / 3,
  },
};
