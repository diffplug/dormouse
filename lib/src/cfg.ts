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
    /** EXPERIMENTAL. Motion treatment while the focus ring travels between panes:
     *  'none' (today's plain tween), 'directional' (Gaussian smear along the travel
     *  axis), or 'trail' (fading ghost copies). A settled or reduced-motion ring is
     *  always clean regardless — the treatment rides the tween's per-frame velocity,
     *  which is null when not travelling. */
    motionBlur: 'directional' as 'none' | 'directional' | 'trail',
    /** directional: per-axis blur sigma = clamp(|v_axis| * blurGain, 0, blurMaxPx),
     *  with v in px/ms. Gain 3 puts a typical adjacent-pane travel (~1.5px/ms) at
     *  sigma ~4-5; the eased peak at travel start clamps at blurMaxPx then decays. */
    blurGain: 3,
    /** directional: hard cap on blur sigma (px) so the fastest travels don't smear
     *  into soup. Capped near the ants stroke width: a 1px line at sigma 6 falls to
     *  ~7% peak alpha and effectively vanishes mid-flight (verified in stills);
     *  sigma 3 keeps both ring modes legible while still reading as motion. */
    blurMaxPx: 3,
    /** trail: how many ghost copies trail the live ring. */
    trailCount: 3,
    /** trail: per-copy opacity falloff — ghost i (0 = nearest) fades to
     *  trailFalloff^(i+1). */
    trailFalloff: 0.45,
  },
};
