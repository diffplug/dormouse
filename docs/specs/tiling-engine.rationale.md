# Tiling Engine (Lath) — Rationale

> Informative companion to [tiling-engine.md](tiling-engine.md): the evidence and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "What, not why"). Nothing here is normative.

## Why

Lath is named for the strips hidden behind a plaster wall. The five taxes dockview-react charged, and what Lath does instead:

**Activation conflated user intent with engine mechanics.** `onDidActivePanelChange` fired identically for clicks, drags, focus adoption, and every programmatic mutation, so a "programmatic-activation" tag existed purely to reconstruct intent the engine had thrown away. Rendering was coupled to the same signal — a pane rendered only once it was its group's active panel, which forced an add-active-then-hand-back dance behind every focus-neutral surface creation. With no activation events, selection policy lives at each mutation site with nothing to mute.

**Tree rebalance re-parented DOM.** Collapsing a branch physically moved the survivor's subtree, blurring the focused xterm and reloading any `<iframe>` that moved with it — recurring bugs that could only be *healed* under dockview (re-focus after the fact, reload guards), never prevented.

**Animation was adversarial.** The kill animation was a FLIP hack fought against the engine: rect snapshots taken before the mutation, `animationend` plus a safety timeout because the event was not reliable, double-finalize guards, and a re-resolve guard for dockview's `'invalid operation'` throw when the layout changed underneath. A pure function of time needs none of those guards.

**DnD was single-level.** Drops targeted one group's edges, with no way to express "beside this entire column" — there was no path to an ancestor split. Its native HTML5 drag events also raced React's synthetic ones.

**Dormouse already kept a shadow model.** DOM neighbor inspection, layout snapshots carrying structure signatures, and spatial navigation doing rect math over group elements — the app continuously re-derived the tree dockview owned but did not usefully share. Lath's pure `neighbors()` / `layout()` queries replaced that DOM math.

## Core model

**Why the zoomed leaf stops short of the wall edge.** The inset is half a pane header (15px of the 30px `PANE_HEADER_HEIGHT_PX`), leaving the tiled panes visible as a thin perimeter. That exposed border, plus the blurred app-background-colored shadow LathHost paints while the leaf is elevated, reads as "floating above the wall" rather than "replaced the wall" — the user has to believe unzoom will put everything back.

## Operations

**Why speculative evaluation is free.** Every op is a pure function over an immutable tree: running one and laying out the result costs no commit, no notify, no cleanup, and the discarded tree is garbage. Under an engine that mutated in place, both the per-frame sash re-layout and the preview-that-is-the-committed-rect would have needed a snapshot-and-rollback dance.

## Hierarchical drag and drop

**Why duplicate ancestor candidates exist to be filtered.** Removing the dragged leaf frequently collapses the column it came from, and once the flatten invariant runs, an `edge` target at the ancestor level and the same edge at its surviving child level lay out identically. Both are legitimate ops with distinct descriptors and only the committed result coincides, so the filter compares committed layouts, not targets: a descriptor-level dedupe would keep both and hand the user two wheel stops that look the same.

**The header-press quirk.** A pane drag starts from a `pointerdown` the header has already handled as a click, so the pane is selected and in passthrough by the time the 5px threshold trips. Suppressing it would mean deferring the header's own click until the gesture resolves, and the end state is the one a drag wants anyway — the dragged pane is the selected pane.

## Parked leaves

**Why a parked leaf holds its rect instead of hiding cheaply.** Sizing it to zero — or `display: none` — reports a 0×0 viewport to the guest document, so the guest reflows on the way out and again on the way back; a screencast canvas and an `<iframe>`'s layout both visibly re-settle. Holding the last rect behind `visibility: hidden` skips both reflows, making reattach pixel-identical rather than merely fast.

**Why the parked rect lives in the store, not the adapter.** React detaches a ref callback whenever its identity changes, and on every StrictMode commit, so adapter-local pruning keyed on `registerEl(null)` fired constantly and silently dropped every parked rect, leaving reattach on the whole-wall fallback.

**Why `seed` admits by tree membership.** Hydration passes the persisted Door rows alongside the tree's leaves, so a parked id appears in `seed`'s input while deliberately absent from the tree. Admitting on that metadata would unpark it — unmounting the very DOM the park exists to preserve — at the one moment the user expects the minimized `<iframe>` to still be warm.

**Why every metadata reader funnels through `lath.getMeta(id)`.** The readers spread across reattach, `dor` param lookup, kill/session teardown, `buildDorSurfaces`, `dor list`, the dev-server port scan, and the session save: a Door record with its own copy of title/params would have to be updated by all of them or go stale in one. Routing them through the single map makes "is it Doored?" a question about the tree alone.

## The wall store and engine

**Who reads `listPanes()`.** `buildDorSurfaces`, the kill selection tail, the session save, and the dev-server port correlation — every one of them treats the result as "the panes the user can see".

**Why a zero-area geometry report is rejected instead of stored.** `autoEdge` on a 0×0 rect finds every split taller-than-wide and answers `'bottom'`, so a seed reading that geometry stacks every pane vertically. Refusing the report leaves the reader on the `!geometry` path, whose fallback is `'right'` — arbitrary rather than systematically wrong, and self-correcting on the first real measurement.

## The HTML adapter (LathHost)

**Why geometry is reported from the measuring layout effect.** The Wall's seed runs in a passive effect and reads the reported geometry through `addLeaf`'s `autoEdge`. Passive effects run after paint and after children's passive effects, so a passive-effect report is still one commit behind at seed time; the observed symptom was geometry stuck at the mount-time 0×0, with the vertical-stack seed described under "The wall store and engine". A layout effect runs children-first before paint, putting the real measured rect in the store on the same commit the seed reads it.

## Animation

**Why a rate must come from `slope(t)`.** Differencing successive `framesAt` samples reports a velocity one frame stale, and nothing at all on the first frame, where there is no previous sample — exactly the frame a follower needs to start moving with the thing it follows. `Easing.slope(t)` is analytic, so it answers at `t = 0`.

**Why a parked leaf's held rect outranks an explicit enter hint.** An enter hint is cosmetic — which boundary a new leaf grows from. A re-admitted parked leaf is a live document that has been laying out at the held rect the whole time it was Doored, so starting it collapsed against an edge would force the guest through the reflow the park exists to avoid.

**Why the surface ref is forgotten only after the removal commits.** A fading leaf is still in `listPanes()` for the length of the exit animation, so a `dor` projection built in that window would re-mint a ref for it — an early delete would not stick, leaving projection and tree disagreeing until the next commit.

**Why a no-deps layout effect re-asserts the current frames.** Animator frames are applied imperatively to the leaf divs, while React independently keeps rendering each div at its *target* geometry, so any unrelated commit mid-tween rewrites the inline styles back to the target and snaps the animation. Re-asserting after every commit costs one style write and removes the whole class of "some other state change made the tween jump."

## Testing

**What the live acceptance run covered.** Beyond walking every matrix row live through the standalone agent-browser harness, the run frame-sampled the motion rows (row 11's freeze-and-fade plus survivor tween, with a second kill fired 200ms into the first; row 6's shrink-to-corner and its top-left refill) and compared preview against commit pixel-exactly at leaf, column, and root depth (row 12). The observables are independent of engine internals.

| # | Flow | Expected observable |
| --- | --- | --- |
| 1 | Type into the selected terminal | Keystrokes echo; `dor list` marks it `*` (focused) |
| 2 | `dor iframe <url>` / `dor ensure` from a touched terminal | Surface created in the background; caller keeps DOM focus (`document.activeElement` stays its xterm textarea) and selection; follow-up typing lands |
| 3 | Click between panes (body and header), both directions | Selection and focus follow the click; passthrough entered |
| 4 | `dor kill` of a background surface | Surface removed; caller's selection, focus, and typing all survive (focus is never lost, not healed) |
| 5 | Kill the selected pane (`dor kill` self or confirm flow) | Selection adopts a survivor; typing works there |
| 6 | Minimize the last pane | Door created and selected; auto-spawn fills the Wall; door keeps selection through the spawn |
| 7 | Click a door | Reattach at original position when structure allows (exact tier); pane selected |
| 8 | Embedded page focuses itself (iframe surface) | Selection moves onto that pane — visible jump, same as a click; never a silent desync |
| 9 | Zoom toggle on a pane | Pane rises, expands to the 15px-inset wall rect, then shrinks and lowers on return; layout identical after |
| 10 | Restart the app (harness re-open) | Layout, doors, titles, and params restored |
| 11 | Kill with animation | Fade in place, survivors tween into the space; a second kill mid-tween retargets cleanly; reduced-motion instant |
| 12 | Drag a pane to a leaf edge, an ancestor edge, and center | Split beside pane/column/row or swap; preview matches commit; dragging while a door is selected selects the dragged pane |
| 13 | Drag a pane onto the baseboard; drag a door out | Minimize with token; restore at the hit-tested position |

Row 8's counterpart guard — a background `dor` command never yanks cross-frame
focus out of the host editor — is checked against VS Code rather than the
standalone harness.
