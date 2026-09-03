# Layout — Rationale

> Informative companion to [layout.md](layout.md): the evidence, measurements, and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "The rationale split"). Nothing here is normative.

## Pane body

xterm.js paints only its own rendered surface, and integer row fitting leaves a sub-row remainder at the bottom of the pane. A host background that differs from the terminal screen therefore shows as a stripe under the last row, and an unclipped host squares off the pane's rounded bottom corners.

## Spoken-alarm overlay

**Why the wash sits below the header.** `--color-alarm-vs-terminal` is picked for contrast against the *terminal body*, so it carries no contrast guarantee over the header band. Staying at `z-index: 19` also leaves the `z-index: 20` pane-corner mouse-override banner untinted.

**Why a perimeter ring rather than an inset border.** An inset border at the leaf's edge covers nothing; and a ring *below* the header would break the read of one rounded rectangle around the whole Pane, which is the point of the treatment.

**Why header popovers are not a factor.** Every one — pane context menu, title candidates, notification preview, rename warning — portals to `document.body` with `position: fixed`, so it renders in the root stacking context above the whole wall regardless of leaf z-indices.

## Baseboard

**Why `showBaseboard={false}` is a seam.** No production host passes it: the mobile Pocket composition is a separate `MobileWall` (`docs/specs/mobile-terminal-ui.md`), not a baseboard-less Wall. The prop exists so an embedder with no door/minimize workflow stays buildable, not as a configuration to design against.

## Mode switching

**Why both gesture tracks stay live everywhere.** Keyboards with no right Meta key are common on Windows and Linux laptops, so the Shift track is the only available gesture there. Keeping both tracks live on every platform avoids a platform switch inside the detector and leaves macOS users a fallback when a hand is already on Shift.

## Split cwd inheritance

**What the shared focus tail costs.** Manual splits and host New Terminal actions both select the new pane and enter passthrough, so building a layout by repeated splits means re-entering command mode between each one. Control-plane creation keeps its background behavior precisely so a script does not fight the user's focus.

## Selection overlay

The passthrough `solid` variant replaced the original `border: 1px solid ${color}` CSS border and was placed pixel-identically — centerline `strokeWidth/2` inside the div edge — so the move to a single SVG renderer for both variants changed no geometry.

**The inflate arithmetic.** With `SELECTION_RING_INFLATE_PX` at 4, the 1px passthrough border spans [3px, 4px] from the pane edge — dead centre of the 7px gutter, on whole pixels because the gutter is odd. That is the whole reason `PANE_GUTTER_PX` is odd.

## Ring travel

**Why the JS tween is not what DESIGN.md bans.** That rule bans CSS *transitions* on layout properties, which the compositor cannot run off the main thread. The overlay instead writes true interpolated values each rAF frame, inside the same pointer-events-none carve-out the Lath animator holds.

**Why the per-frame writes are imperative.** It is the React-owns-structure / frame-owns-mutations split LathHost already uses for the animator. Reconciling the ring subtree once per frame competes with the travel itself for the same frame budget, and the ring is the thing whose smoothness the user is watching.

## Directional motion smear

**Analytic velocity.** `sampleRingVelocity` differentiates the tween directly: an edge at `from + (to - from) * E(t)` moves at `|to - from| * E'(t) / durationMs`, with `E'` from `LATH_EASING.slope`. The house ease-out peaks at `E'(0) = 4.545×` its average speed, which is why the blur belongs on the opening frame. Finite-differencing rendered positions was tried and failed three ways: there is no previous sample on frame one, so the smear was hidden outright for the frame covering ~31% of a 220ms travel; an EMA over it lagged ~1.7 frames; and a backward difference under-reports any decelerating curve, landing the rendered peak mid-travel at ~46% of the true value. Analytic velocity is also jitter-free by construction, so it needs no smoothing.

**Extent and intensity.** Ink conservation — dividing alpha by the widening factor — would tie peak alpha to extent, making the effect impossible to strengthen by widening. `smearFullSpeed` is left as the single shape knob over a travel: low values pin nearly every move at full smear, high values make the blur track speed.

**Per-edge speeds.** The counterexample that rules out per-axis speeds (e.g. from the ring *centre's* velocity): moving between panes flush at the top but differing in height, the top edge translates purely sideways and must stay crisp while the bottom edge moves diagonally and smears hard. A centre velocity averages those into the same wrong answer for both.

**Why two layers.** The ring is one closed path so the dash phase runs unbroken around the perimeter, and SVG `stroke-width` is a single scalar — so that one path cannot carry four different widths.

**The corner taper.** A corner must reach two widths at once, so it is stroked at unit width under `transform: scale(a, b)` — `a` the vertical neighbour's width, `b` the horizontal neighbour's — and `cornerPath` pre-divides the arc by the same pair so the on-screen curve is unchanged. Opacity cannot vary along a stroke, so a corner takes the mean of its two edges'.

**Closed-form dash length.** `1.6232252401402307 × r` is the arc length of the quadratic quarter-turn the path actually draws; the quarter-*circle* value `π/2` is 3% short. `SVGGeometryElement.getTotalLength()` costs a synchronous style+layout flush per frame at a cost scaling with the whole document, and is itself only an approximation (browsers flatten curves to measure) — verified in Safari to agree with the closed form to 6e-4px on a 3253px ring. Dropping it also retired the jsdom `getTotalLength` stubs, so tests assert real dash geometry.

**The `feGaussianBlur` measurements.** WebKit CPU-rasterizes SVG filters every frame: measured in Safari 26.5 (2026-08) at 25.6ms/frame with 31 of 98 frames over 25ms during ring travel, versus a locked 16.7ms with zero dropped frames after the eight-piece smear replaced the filter.

## Inline rename

Pane headers re-render on every activity, terminal-state, and palette change. An editor that re-derived its value (or re-ran `select()`) on those renders would fight the user mid-word — one re-render between two keystrokes and the second keystroke replaces everything typed so far. That is why the draft state is seeded at mount only and the `select()` ref callback has a stable identity.

## Renderer

**Why the GL context is claimed lazily.** A GL context is a scarce per-page resource. Claiming at create would spend the budget on surfaces that never paint — cold restore builds a session for every persisted pane, minimized doors included — and because eviction is oldest-first and one-way, the panes it demoted would be the earliest-restored ones, permanently.

**DOM-renderer cost.** The DOM renderer emits one `<span>` per style run per row, so a TUI that paints every cell its own truecolor collapses to one span-with-inline-style *per cell*, rebuilt every frame. On a 99×25 pane that is ~1150 elements of style recalc plus layout per frame: measured in Safari 26.5 (2026-08), a single such pane held the whole page at ~110ms/frame (~9fps) while the rest of the app was idle. The same pane on the WebGL renderer holds a locked 60fps (16.6ms, zero frames over 25ms).

**Why the `WebGL2RenderingContext` pre-check exists.** Without it every terminal in a jsdom unit run logs a `getContext` failure before the swallowed constructor throw, which buries real output.

**Context budget.** The per-page live-context cap was measured at 16 in Safari 26.5, evicted oldest-first. The `onContextLoss` → dispose-the-addon → DOM-fallback path was verified live by exhausting the budget and watching the demoted panes keep painting.

**Verification status.** The numbers above are Safari 26.5; Chrome was checked structurally. Not yet verified inside Tauri's WKWebView (as of 2026-08) — same engine as Safari, and Tauri does not disable the GPU, so it is expected to work; read `data-renderer` on a pane's host element to confirm.

## Animations

**Why `refitSession` is throttled.** An unthrottled ResizeObserver refits once per animated cell-boundary crossing, so one 440ms motion or a single sash drag costs dozens of xterm reflows and PTY resizes. Leading-edge throttling plus a trailing call collapses that to a handful while still landing an exact fit once the geometry settles.

## Kill (two-phase fade + tween reclaim)

**Why the selected-pane check is re-read live.** A selection move *during* the fade has to work in both directions: navigate away from a dying selected pane and the tail must not yank selection back onto a survivor; navigate onto a dying pane and the tail must adopt a survivor rather than leave selection dangling on a removed leaf. A flag captured when the kill started answers only the first case.

**Which callers hit which branch.** The header kill button is always a selected-pane kill, since clicking the header selects the pane before the button's click handler runs. The not-selected cases in practice are `dor kill` of a background surface and ensure's throwaway teardown.

## Auto-spawn refill

**Why the refill may fire re-entrantly.** The killed pane's fade already sequenced the removal, so the refill needs no delay of its own; adding one would show an empty Wall for a frame between the two commits.
