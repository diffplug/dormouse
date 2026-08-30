# Tiling Engine (Lath) — Rationale

> Informative companion to [tiling-engine.md](tiling-engine.md): the evidence and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "The rationale split"). Nothing here is normative.

## Why

The five taxes dockview-react charged, and what Lath does instead. Each line in the spec's principles, adapter, animation, and DnD sections is the surviving rule; this is the case history behind it.

**Activation conflated user intent with engine mechanics.** `onDidActivePanelChange` fired identically for clicks, drags, focus adoption, and every programmatic mutation, so a "programmatic-activation" tag existed purely to reconstruct intent the engine had thrown away. Rendering was coupled to the same signal — a pane rendered only once it was its group's active panel, which forced an add-active-then-hand-back dance behind every focus-neutral surface creation. Lath has no activation events at all: gestures arrive as op proposals, so selection policy lives at each mutation site with nothing to mute.

**Tree rebalance re-parented DOM.** Collapsing a branch physically moved the survivor's subtree, which blurred the focused xterm and reloaded any `<iframe>` that moved with it. Both were recurring bugs that could only be *healed* under dockview (re-focus after the fact, reload guards). Lath's binding never re-parents a leaf element, so the bug classes do not exist to heal.

**Animation was adversarial.** The kill animation was a FLIP hack fought against the engine: rect snapshots taken before the mutation, `animationend` plus a safety timeout because the event was not reliable, double-finalize guards, and a re-resolve guard for dockview's `'invalid operation'` throw when the layout changed underneath. Lath's animator is a pure function of time, so none of those guards have a reason to exist.

**DnD was single-level.** Drops targeted one group's edges, with no way to express "beside this entire column" — there was no path to an ancestor split. Its native HTML5 drag events also raced React's synthetic ones, which is why Lath's gesture is pointer-events-only.

**Dormouse already kept a shadow model.** DOM neighbor inspection, layout snapshots carrying structure signatures, and spatial navigation doing rect math over group elements — the app continuously re-derived the tree dockview owned but did not usefully share. Lath owns the tree outright, and its pure `neighbors()` / `layout()` queries replaced that DOM math.

## Testing

**What the live acceptance run covered.** Beyond walking every matrix row through the standalone agent-browser harness, the run frame-sampled the motion rows — kill freeze-and-fade followed by the survivor tween, the last-pane shrink-to-corner with its top-left auto-spawn entry, and continuous retarget under two kills fired 200ms apart — and checked pixel-exact preview-equals-commit for drops at leaf, column, and root depth.
