# Tiling Engine (Lath) — Rationale

> Informative companion to [tiling-engine.md](tiling-engine.md): the evidence and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "What, not why"). Nothing here is normative.

## Principles and non-goals

Lath replaced dockview-react, whose broader model charged five taxes:

**Activation conflated user intent with engine mechanics.** `onDidActivePanelChange` fired identically for clicks, drags, focus adoption, and every programmatic mutation, so a "programmatic-activation" tag existed purely to reconstruct intent the engine had thrown away. Rendering was coupled to the same signal — a pane rendered only once it was its group's active panel, which forced an add-active-then-hand-back dance behind every focus-neutral surface creation. With no activation events, selection policy lives at each mutation site with nothing to mute.

**Tree rebalance re-parented DOM.** Collapsing a branch physically moved the survivor's subtree, blurring the focused xterm and reloading any `<iframe>` that moved with it — recurring bugs that could only be *healed* under dockview (re-focus after the fact, reload guards), never prevented.

**Animation was adversarial.** The kill animation was a FLIP hack fought against the engine: rect snapshots taken before the mutation, `animationend` plus a safety timeout because the event was not reliable, double-finalize guards, and a re-resolve guard for dockview's `'invalid operation'` throw when the layout changed underneath. A pure function of time needs none of those guards.

**DnD was single-level.** Drops targeted one group's edges, with no way to express "beside this entire column" — there was no path to an ancestor split. Its native HTML5 drag events also raced React's synthetic ones.

**Dormouse already kept a shadow model.** DOM neighbor inspection, layout snapshots carrying structure signatures, and spatial navigation doing rect math over group elements — the app continuously re-derived the tree dockview owned but did not usefully share. Lath's pure `neighbors()` / `layout()` queries replaced that DOM math.

## Hierarchical drag and drop

**Flexible scopes without a new tree format.** A flat row already models any number of children. The missing expression was a temporary rectangle spanning adjacent children: forcing that group into the stored tree conflicts with same-direction flattening. A child range captures the drop scope without making split history observable. Removing a pane can dissolve an old subtree into siblings; resolving the entire surviving leaf set retains the chosen rectangle.

**Slides, not the wheel.** Scopes were first cycled with the scroll wheel, one level per wheel event. A trackpad flick sends dozens of wheel events including momentum, so on a trackpad (most users) the chosen scope was effectively random; contiguous ranges also multiplied the stops, from 2 to 4, 9, and 16 for 4-, 6-, and 8-pane rows. A slide names its span directly, and evaluating one scope per frame costs about 0.27ms on an 80-pane row (measured in Node 24, 2026-10), where enumerating every range cost about 98ms.

**Equal spans resolve to the innermost.** With the flatten invariant, scopes sharing a line and a span differ only in the new pane's perpendicular size, never in arrangement, so one of them stands for all.

**Pausing anchors the slide.** A pane drag starts on its header, inside its top band, and moving it sideways crosses every other header's top band. Anchoring on contact would stretch a group from the dragged pane on every such sweep; anchoring on a pause leaves quick sweeps naming one pane at a time.

**Lines before slides.** Most wanted scopes are the tree's own groups: beside one pane, between two, or along a whole side. Reaching a group by pause-and-slide hid them behind a timed gesture, so the gutter and the wall's edge name the group directly and the slide remains for partial ranges. A top edge's line stays outside the leaf because the header fills its top 30px: an inner strip there would turn every sweep across the header row into a full-width drop.

**The header-press quirk.** A pane drag starts from a `pointerdown` the header has already handled as a click, so the pane is selected and in passthrough by the time the 5px threshold trips. Suppressing it would mean deferring the header's own click until the gesture resolves, and the end state is the one a drag wants anyway — the dragged pane is the selected pane.

## Parked leaves

Unbounded parking preserves unsaved iframe state; a ninth minimized browser previously evicted the oldest document and made reattachment reload it. Hidden documents can keep consuming memory and running scripts, timers, sockets, and media. A future resource warning is low priority, tracked in https://github.com/diffplug/dormouse/issues/610.

**Why a parked leaf holds its rect instead of hiding cheaply.** Sizing it to zero — or `display: none` — reports a 0×0 viewport to the guest document, so the guest reflows on the way out and again on the way back; a screencast canvas and an `<iframe>`'s layout both visibly re-settle. Holding the last rect behind `visibility: hidden` skips both reflows, making reattach pixel-identical rather than merely fast.

**Why every metadata reader funnels through `lath.getMeta(id)`.** Metadata readers span several modules: a Door record with its own copy of title/params would have to be updated by every one of them or go stale in one. Routing them through the single map makes "is it Doored?" a question about the tree alone.

## Animation

**Why a rate must come from `slope(t)`.** Differencing successive `framesAt` samples reports a velocity one frame stale, and nothing at all on the first frame, where there is no previous sample — exactly the frame a follower needs to start moving with the thing it follows. `Easing.slope(t)` is analytic, so it answers at `t = 0`.

**Why a parked leaf's held rect outranks an explicit enter hint.** An enter hint is cosmetic — which boundary a new leaf grows from. A re-admitted parked leaf is a live document that has been laying out at the held rect the whole time it was Doored, so starting it collapsed against an edge would force the guest through the reflow the park exists to avoid.
