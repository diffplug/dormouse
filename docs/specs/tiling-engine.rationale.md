# Tiling Engine (Lath) — Rationale

> Informative companion to [tiling-engine.md](tiling-engine.md): the evidence and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "The rationale split"). Nothing here is normative.

## Why

The five taxes dockview-react charged, and what Lath does instead. Each line in the spec's principles, adapter, animation, and DnD sections is the surviving rule; this is the case history behind it.

**Activation conflated user intent with engine mechanics.** `onDidActivePanelChange` fired identically for clicks, drags, focus adoption, and every programmatic mutation, so a "programmatic-activation" tag existed purely to reconstruct intent the engine had thrown away. Rendering was coupled to the same signal — a pane rendered only once it was its group's active panel, which forced an add-active-then-hand-back dance behind every focus-neutral surface creation. Lath has no activation events at all: gestures arrive as op proposals, so selection policy lives at each mutation site with nothing to mute.

**Tree rebalance re-parented DOM.** Collapsing a branch physically moved the survivor's subtree, which blurred the focused xterm and reloaded any `<iframe>` that moved with it. Both were recurring bugs that could only be *healed* under dockview (re-focus after the fact, reload guards). Lath's binding never re-parents a leaf element, so the bug classes do not exist to heal.

**Animation was adversarial.** The kill animation was a FLIP hack fought against the engine: rect snapshots taken before the mutation, `animationend` plus a safety timeout because the event was not reliable, double-finalize guards, and a re-resolve guard for dockview's `'invalid operation'` throw when the layout changed underneath. Lath's animator is a pure function of time, so none of those guards have a reason to exist.

**DnD was single-level.** Drops targeted one group's edges, with no way to express "beside this entire column" — there was no path to an ancestor split. Its native HTML5 drag events also raced React's synthetic ones, which is why Lath's gesture is pointer-events-only.

**Dormouse already kept a shadow model.** DOM neighbor inspection, layout snapshots carrying structure signatures, and spatial navigation doing rect math over group elements — the app continuously re-derived the tree dockview owned but did not usefully share. Lath owns the tree outright, and its pure `neighbors()` / `layout()` queries replaced that DOM math.

## Parked leaves

**Why a parked leaf holds its rect instead of hiding cheaply.** Sizing it to zero — or `display: none` — reports a 0×0 viewport to the guest document, so the guest reflows on the way out and again on the way back; a screencast canvas and an `<iframe>`'s layout both visibly re-settle. Holding the last rect behind `visibility: hidden` skips both reflows, which is what makes reattach pixel-identical rather than merely fast.

## Testing

**What the live acceptance run covered.** Beyond walking every matrix row through the standalone agent-browser harness, the run frame-sampled the motion rows — kill freeze-and-fade followed by the survivor tween, the last-pane shrink-to-corner with its top-left auto-spawn entry, and continuous retarget under two kills fired 200ms apart — and checked pixel-exact preview-equals-commit for drops at leaf, column, and root depth.

Each row was driven live; the observables are independent of engine internals.

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
