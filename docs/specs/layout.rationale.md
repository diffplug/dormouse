# Layout — Rationale

> Informative companion to [layout.md](layout.md): the evidence, measurements, and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "The rationale split"). Nothing here is normative.

## Selection overlay

The passthrough `solid` variant replaced the original `border: 1px solid ${color}` CSS border and was placed pixel-identically — centerline `strokeWidth/2` inside the div edge — so the move to a single SVG renderer for both variants changed no geometry.

## Directional motion smear

**Analytic velocity.** `sampleRingVelocity` differentiates the tween directly: an edge at `from + (to - from) * E(t)` moves at `|to - from| * E'(t) / durationMs`, with `E'` from `LATH_EASING.slope`. The house ease-out peaks at `E'(0) = 4.545×` its average speed, which is why the blur belongs on the opening frame. Finite-differencing rendered positions was tried and failed three ways: there is no previous sample on frame one, so the smear was hidden outright for the frame covering ~31% of a 220ms travel; an EMA over it lagged ~1.7 frames; and a backward difference under-reports any decelerating curve, landing the rendered peak mid-travel at ~46% of the true value. Analytic velocity is also jitter-free by construction, so it needs no smoothing.

**Per-edge speeds.** The counterexample that rules out per-axis speeds (e.g. from the ring *centre's* velocity): moving between panes flush at the top but differing in height, the top edge translates purely sideways and must stay crisp while the bottom edge moves diagonally and smears hard. A centre velocity averages those into the same wrong answer for both.

**Closed-form dash length.** `1.6232252401402307 × r` is the arc length of the quadratic quarter-turn the path actually draws; the quarter-*circle* value `π/2` is 3% short. `SVGGeometryElement.getTotalLength()` costs a synchronous style+layout flush per frame at a cost scaling with the whole document, and is itself only an approximation (browsers flatten curves to measure) — verified in Safari to agree with the closed form to 6e-4px on a 3253px ring. Dropping it also retired the jsdom `getTotalLength` stubs, so tests assert real dash geometry.

**The `feGaussianBlur` measurements.** WebKit CPU-rasterizes SVG filters every frame: measured in Safari 26.5 (2026-08) at 25.6ms/frame with 31 of 98 frames over 25ms during ring travel, versus a locked 16.7ms with zero dropped frames after the eight-piece smear replaced the filter.

## Renderer

**Why the GL context is claimed lazily.** A GL context is a scarce per-page resource. Claiming at create would spend the budget on surfaces that never paint — cold restore builds a session for every persisted pane, minimized doors included — and because eviction is oldest-first and one-way, the panes it demoted would be the earliest-restored ones, permanently.

**DOM-renderer cost.** The DOM renderer emits one `<span>` per style run per row, so a TUI that paints every cell its own truecolor collapses to one span-with-inline-style *per cell*, rebuilt every frame. On a 99×25 pane that is ~1150 elements of style recalc plus layout per frame: measured in Safari 26.5 (2026-08), a single such pane held the whole page at ~110ms/frame (~9fps) while the rest of the app was idle. The same pane on the WebGL renderer holds a locked 60fps (16.6ms, zero frames over 25ms).

**Context budget.** The per-page live-context cap was measured at 16 in Safari 26.5, evicted oldest-first. The `onContextLoss` → dispose-the-addon → DOM-fallback path was verified live by exhausting the budget and watching the demoted panes keep painting.

**Verification status.** The numbers above are Safari 26.5; Chrome was checked structurally. Not yet verified inside Tauri's WKWebView (as of 2026-08) — same engine as Safari, and Tauri does not disable the GPU, so it is expected to work; read `data-renderer` on a pane's host element to confirm.

## Inline rename

Pane headers re-render on every activity, terminal-state, and palette change. An editor that re-derived its value (or re-ran `select()`) on those renders would fight the user mid-word — one re-render between two keystrokes and the second keystroke replaces everything typed so far. That is why the draft state is seeded at mount only and the `select()` ref callback has a stable identity.
