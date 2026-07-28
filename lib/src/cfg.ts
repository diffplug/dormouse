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
    // Directional motion blur while the focus ring travels between panes. Driven by
    // the ring center's per-frame velocity (px/ms); a settled or reduced-motion ring
    // has null velocity, so it never blurs.
    /** Per-axis blur sigma = clamp(|v_axis| * blurGain, 0, blurMaxPx). Gain 3 puts a
     *  typical adjacent-pane travel (~1.5px/ms) at sigma ~4-5; the eased peak at
     *  travel start clamps at blurMaxPx then decays. */
    blurGain: 3,
    /** Hard cap on blur sigma (px). Capped near the ants stroke width: a 1px line at
     *  sigma 6 falls to ~7% peak alpha and effectively vanishes mid-flight (verified
     *  in stills); sigma 3 keeps both ring modes legible while still reading as motion. */
    blurMaxPx: 3,
    /** EMA weight of the newest velocity sample (0..1). The raw finite-difference
     *  velocity jitters with rAF frame-timing noise, which makes the blur pulse;
     *  blending toward the previous smoothed value steadies it. 1 = no smoothing
     *  (rawest), lower = steadier but slightly laggier. 0.6 removes single-frame
     *  spikes with no perceptible lag over the 220ms travel. */
    blurSmoothing: 0.6,
  },
};
