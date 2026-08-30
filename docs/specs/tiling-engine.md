# Tiling Engine (Lath)

> See [glossary.md](glossary.md) for the Surface model, the `Window ⊃ Workspace ⊃ Pane ⊃ Surface` hierarchy, and the Pane / Door / baseboard / passthrough vocabulary used here.
> **Owns** the engine internals: the pure core under `lib/src/lib/lath/` (model, layout, ops, animator, hit-testing) plus the Wall binding with native motion and hierarchical DnD. Lath — named for the strips hidden behind a plaster wall — replaced dockview-react; that dependency is gone.
> **Defers** the interaction model on top to [layout.md](layout.md): selection, focus, modes, session lifecycle. Not re-disclaimed per section below.
> Evidence behind the rules: [tiling-engine.rationale.md](tiling-engine.rationale.md).

## Why

Dormouse used a narrow slice of dockview — binary split tree, sash resize, drag-move, maximize, serialization — yet paid a broad tax for the parts of its model that fought the product. **Never reintroduce any of the five**; each survives as a live rule in its own section (rationale).

| dockview's tax | Lath's answer |
| --- | --- |
| Activation events conflated user intent with engine mechanics | No activation events at all (Principles) |
| Tree rebalance re-parented DOM | The binding never re-parents (The HTML adapter) |
| The kill animation had to fight the animation model | The animator is a pure function of time (Animation) |
| Single-level DnD raced React's synthetic events | Pointer-only hierarchical DnD |
| The app re-derived a shadow model of the tree | Pure `neighbors()` / `layout()` queries (Layout) |

## Principles and non-goals

Lath is a **headless geometry engine**: it owns the split tree, rects, animation targets, and drag hit-testing — nothing else.

- **Every operation is `(tree, args) → result`.** No listeners, no event emitters, no timing assumptions.
- **The core must never import DOM, React, or Three.js types.** Tree, `layout()`, ops, hit-testing, sash geometry, and the animator are all plain-data-in, plain-data-out. LathHost is the first consumer; a Three.js adapter (the VR Window item in [remote-api.md](remote-api.md)'s staged remainder) is a planned second and must be able to reuse all of it unchanged.
- **Never give Lath a concept of selection, focus, mode, or activation.** Those stay in the Wall, where the (kind, id) selection pair and its policies already live.
- **The DOM binding never re-parents a pane's element.** Layout is geometric (absolute position + size on stable nodes), not structural.
- **Non-goals**: tab stacking, floating groups, popout windows (agent-browser pop-out is a separate mechanism), and the mobile compositions (MobileWall does not tile). Building the Three.js adapter itself is also out of scope — the guarantee is only that the core stays consumable by one.

## Core model

Source of truth: `lib/src/lib/lath/model.ts`.

```ts
type LeafId = string;                        // the Wall maps Pane id ↔ leaf id 1:1
type Edge = 'left' | 'right' | 'top' | 'bottom';

type LathNode =
  | { kind: 'leaf'; id: LeafId }
  | { kind: 'split'; dir: 'row' | 'col'; children: LathChild[] };

type LathChild = { node: LathNode; weight: number };

type LathTree = { root: LathNode | null };
```

A `'row'` split lays children left→right; `'col'` top→bottom. **Trees are immutable**: ops return fresh nodes along the mutated path and share structure elsewhere.

Invariants, enforced by every op and checked by `validate(tree)` (human-readable violations; used throughout the tests):

- A split has ≥ 2 children and **never directly contains a same-direction split** — same-direction children are flattened on construction, i3-style, by the shared `normalize` constructor every op builds through. This normalization is what gives DnD its depth semantics: every ancestor boundary is a real, distinct drop level.
- Weights within a split are > 0 and normalized to sum 1.
- Leaf ids are unique. `root: null` is the empty Wall; the "always one pane visible" auto-spawn rule stays app-level (a Wall effect watches the store and spawns into an emptied tree). **There is no op for inserting into an empty tree** — the Wall seeds one with `leafTree(id)`.

Nodes are addressed by **path** (`number[]` of child indexes from the root; the root is `[]`). **Paths are ephemeral** — valid only until the next op, never persisted.

**Zoom is never in the tree.** It is presentation state (`zoomedId` in the wall store): the zoomed leaf animates into an elevated wall-sized rect inset by half the 30px pane-header height (15px), while the tree, every other rect, and all leaf DOM stay unchanged beneath. The exposed perimeter and blurred app-background-colored shadow make the stacking relationship visible.

## Layout

Source of truth: `lib/src/lib/lath/layout.ts`.

```ts
layout(tree: LathTree, rect: Rect, opts: { gap: number; minLeaf: Size }): Map<LeafId, Rect>
```

Pure. Splits divide their axis by weight and round to integer pixels so children plus gaps tile the span exactly — **adjacent panes never seam or overlap**. Weights are clamped at layout time against `minLeaf` via a per-split waterfill (children below their recursive minimum are pinned to it and the rest redistributes by weight); **stored weights are never rewritten by layout**. A split whose minimums exceed its span degrades to min-proportional allocation — still exact tiling, minimums honored only when feasible. Zero/negative rects yield zero-size rects, never a crash. Property tests assert: rects exactly tile `rect` minus gaps, no overlap, every leaf present.

Derived pure queries replace DOM inspection. **Each must be called with the same `rect` + `opts` the caller renders with** — feed them anything else and their geometry diverges from the screen:

- `neighbors(tree, rect, id, direction, opts) → LeafId | null` — spatial navigation without rect-scanning group elements. Candidates must lie strictly beyond the leaf's edge; secondary-axis overlap is preferred, then nearest edge-to-edge, with deterministic tie-breaks (smaller y, then x, then id).
- `autoEdge(tree, rect, id, opts) → Edge` — the aspect-ratio split heuristic: laid-out rect wider than tall → `'right'`, else `'bottom'` (also `'right'` for a missing leaf).
- `sashes(tree, rect, opts) → { splitPath, boundary, dir, rect }[]` — one entry per adjacent child pair of every split; `dir` is the parent split's axis (`'row'` → a vertical divider, col-resize) and `rect` is the gap band between the pair (zero-thickness when `gap: 0`; the adapter widens the hit area).
- `nodeRectAtPath(tree, rect, opts, path) → Rect | null` — the rect of any interior node under the same geometry, walking only the root→leaf spine. Feeds `resize`'s px→weight conversion, hit-testing's ancestor-coincidence check, and the store's single-leaf rect lookup.

## Operations

Source of truth: `lib/src/lib/lath/ops.ts`.

All ops are pure and synchronous, returning `{ tree: LathTree; ok: boolean }` plus op-specific fields. **On `ok: false` the returned `tree` is the input tree object** unchanged — callers may identity-compare to detect rejected ops; on `ok: true` the tree is always a fresh object, so tree identity never signals "no visual change."

| Op | Shape | Notes |
| --- | --- | --- |
| `split` | `(tree, at: LeafId, edge, newId)` | Inserts `newId` beside `at`, extending the parent split when directions match (flatten invariant) or nesting a new one. New leaf takes half of `at`'s weight. |
| `remove` | `(tree, id)` | Removes the leaf (siblings absorb its weight proportionally), collapses single-child splits, re-flattens. Returns a `RestoreToken` (below). |
| `replace` | `(tree, oldId, newId)` | Atomic identity swap in place — the `dor iframe` replace-untouched-terminal case becomes one op with no transient add/remove states. |
| `move` | `(tree, id, target: DropTarget)` | Remove + insert as one op; weight follows the leaf (it carries its old normalized weight into the new context). `target.path` is read against the input tree, then re-found post-removal by surviving leaf set (falling back to the target's first surviving leaf if that subtree dissolved). |
| `swap` | `(tree, a, b)` | Leaf identity swap (drag-onto-center; the Cmd-Arrow swap). `a === b` is rejected. |
| `resize` | `(tree, splitPath, boundary, deltaPx, rect, opts)` | Adjusts the two weights adjacent to `boundary` (children `boundary`/`boundary + 1`), clamped so neither side drops below its recursive `minLeaf` span — with an epsilon floor keeping both weights strictly positive (a `minLeaf` of 0 may render 0px but never stores weight 0). A fully-clamped no-op is still `ok: true`. Streamed during a sash drag: pass the *original* tree each frame with a cumulative delta; the final tree commits on pointerup. |
| `insert` | `(tree, id, target: DropTarget, weight = 0.5)` | The insert half of `move`, public for external (Door) drops: places a NEW leaf at a drop target carrying `weight` (clamped into (0,1)). Swap targets, existing ids, empty trees, and paths off the tree are rejected. |
| `restore` | `(tree, token, opts?)` | Reinserts a removed leaf, best effort (below). |

```ts
type DropTarget =
  | { kind: 'edge'; path: number[]; edge: Edge }   // insert beside the node at path, at its parent's level
  | { kind: 'swap'; leaf: LeafId };
```

`DropTarget`'s `edge`-at-ancestor-path form is what gives DnD its depth levels (Hierarchical drag and drop, below).

Ops are cheap pure functions, so speculative evaluation is free — sash live-resize and DnD previews run `layout(op(tree, …).tree, …)` per frame without committing.

## Hierarchical drag and drop

Source of truth: `lib/src/lib/lath/hit-test.ts` (core); the `DragController` in `lib/src/components/wall/lath-drag-controller.ts` — one gesture owner (threshold, hit-test, click-suppression) for both pane and Door drags, built once per LathHost mount and fed header presses / the `externalDrag` mirror; `Door.tsx` / `Baseboard.tsx` (press reporting only); the drag callbacks in `Wall.tsx`.

**Pointer events only** (`pointerdown` → 5px `DRAG_THRESHOLD` → drag; no HTML5 DnD), so drags are testable from CDP and never race React's synthetic events. A live drag hit-tests the store's tree read fresh each frame, so a background `dor split` / `dor kill` commit mid-drag is reflected in the next preview.

```ts
hitTest(tree, rect, point, dragged: LeafId | null, opts): DropCandidate[]
// DropCandidate = { target: DropTarget; previewRect: Rect; depth: number }, ordered innermost → outermost
```

`hitTest` is core: it takes a point already in Wall coordinates — LathHost feeds pointer positions, a Three.js adapter would feed raycast intersections. `dragged: null` is an external drag (a Door coming in): no `swap` candidates, previews via `insert`. Gesture mechanics and the preview overlay are adapter concerns.

The depth model:

- The center region of a leaf yields `swap` (internal drags only, never with yourself).
- The inner edge bands of a leaf — `min(0.3 × extent, 96)` px per side; the nearest in-band edge wins a corner — yield `edge` targets **at the leaf's level**. A point in a gap attributes to the nearest leaf, so split boundaries have no dead zones.
- When the hovered leaf's edge coincides (≤ 0.5px) with an ancestor boundary, `hitTest` also yields `edge` targets **at each ancestor level** — "beside this entire column," up to the root ("new full-height/width band at the Wall's edge").
- **Every candidate's `previewRect` is the exact rect the drop would commit** — computed by speculatively running `move` (or `insert`) + `layout`, never a heuristic hint zone. Rejected ops, beside-itself no-ops (committed layout identical to current), and duplicates (ancestor levels the flatten invariant collapses into their child's result — common when removing the dragged leaf collapses its column) are filtered out, so every surviving depth is a genuinely different drop.
- Default resolution is the innermost candidate; the **scroll wheel** during a drag cycles outward through `depth` (wrapping; scroll up cycles backward). The candidate list resets to innermost whenever its target set changes.

Adapter gesture (LathHost):

- **Start** on a leaf's header slot, primary button only, bailing on buttons/inputs/contenteditable so header chrome keeps working. **Never while zoomed or during a sash drag** — the two drags are mutually exclusive. Grabbing a header also fires the header's press-time click path first, so a drag begins from passthrough on that pane — selection lands correctly, accepted quirk.
- **During**: the dragged leaf dims to 0.6; one `data-lath-drop-preview` overlay renders the chosen candidate's rect in the selection color; hit-testing is rAF-coalesced; Escape cancels; the click the browser synthesizes on pointerup is swallowed in the capture phase.
- **Drops surface as proposals the Wall commits**: `onDragStart(id)` (Wall moves selection onto the dragged pane — covering the drag-while-door-selected case), `onProposeMove(id, target)` (→ `moveLeaf`, then select), `onProposeMinimize(id)` when released below the container (→ the standard `minimizePane`, token and all; the Wall gates it on `showBaseboard`, so it no-ops when the baseboard is hidden — there is nowhere to minimize into). Committed moves tween via the animator.

**Door drag-out** runs the same threshold / hit-test / preview / wheel machinery with `dragged: null`. A `Door` press reports its start point (`onDoorDragStart(item, press)`) and the Wall puts LathHost into external-drag mode immediately (`externalDrag={ id, startX, startY }`); below the threshold the press is a plain click (reattach), above it the chip stays put in the baseboard. A drop on a candidate removes the Door and `insertLeaf`s the surface at the hit-tested target — **the token is not consulted, because the user chose the position** — with an enter hint from the target edge. A drop on nothing (or Escape, a sub-threshold release, or dropping back onto the baseboard) leaves the Door in place.

## Restore tokens (Doors)

Source of truth: `RestoreToken` and `restore` in `lib/src/lib/lath/ops.ts`.

`remove` returns a JSON-serializable token capturing the leaf's ancestry: the nearest same-parent sibling leaf it sat beside (`siblingId`), the full leaf set and structure fingerprint of that sibling node when the sibling is itself a split subtree (`siblingLeafIds` / `siblingFingerprint`), the edge relationship (`edge`, such that neighbor-tier restore is `split(siblingId, edge, leafId)`), its normalized `weight`, its child `index`, and a structure-only `fingerprint` (kinds, dirs, leaf ids — no weights) of the parent split *post-removal*. `restore` applies a three-tier policy (the Wall drives it from `handleReattach`):

1. **exact** — the fingerprinted context still exists around `siblingId`: reinsert at the original index with the original weight (existing siblings shrink proportionally);
2. **neighbor** — the sibling still exists: split beside it on the original edge;
3. **fallback** — split beside a caller-supplied reference leaf (`opts.fallbackRef`) via `autoEdge` (or `'right'` when no rect is supplied). Restoring into an empty tree makes the leaf the root.

- A leaf removed from a two-child split whose survivor is a single leaf **always degrades to the neighbor tier**: the collapse erases the fingerprinted parent, and the neighbor tier reproduces the same position (at 50/50 rather than the original weights).
- A survivor that is a split subtree keeps the exact tier, targeted by `siblingLeafIds` / `siblingFingerprint`, so `A | (B over C)` restores beside the whole `B/C` column rather than inside it.
- **A token whose sibling is gone and whose caller supplies no `fallbackRef` fails with `ok: false`** — callers own picking a live reference.

Tokens serialize with Doors (`PersistedDoor.token`) as the sole restore payload. A parked leaf (below) still carries one: parking decides whether the DOM survives, the token decides where the leaf lands.

## Parked leaves

Source of truth: `parked` / `doorLeaf` / `addDoor` / `forgetLeaf` / `parkedIds` / `MAX_PARKED_SURFACES` in `lib/src/components/wall/lath-wall-store.ts`; `shouldParkOnMinimize` and `leafMetaFromPersistedDoor` in `lath-wall-engine.ts`; the parked render branch in `LathHost.tsx`; `minimizePane` in `lib/src/components/Wall.tsx`.

A **parked** leaf is mounted by the adapter but absent from the split tree: its DOM survives while it lays out nothing, paints nothing, and takes no input. It exists for Surfaces whose state lives *in the DOM* — an `<iframe>`'s document, a screencast canvas — where a plain remove destroys the state and the reattach is really a reload.

- **Detaching and parking are separate things.** `doorLeaf` takes a leaf out of the tree and *keeps its meta* — what every minimize does, terminal or browser, because the store stays the authority for a Doored Surface's live title/params. `{ park: true }` additionally keeps the leaf **mounted** (the browser-only part). `removeLeaf` destroys a leaf and its meta (a kill); `forgetLeaf` destroys a Door, unmounting it if parked. A Surface **born minimized** — `dor split` / `dor ensure` targeting another Door, with no pane to detach — registers its meta through `addDoor`, so the "one map holds every leaf" invariant has no exception for creation path.
- **Parking must be one commit.** An id absent from both the tree and `parked` for even one render would make React unmount the leaf and lose the DOM state, so every op that re-admits a leaf (`addLeaf`, `restoreLeaf`, `insertLeaf`, `replaceLeaf`, `seed`) unparks it in that same commit through the one shared `admit` helper — which also seeds the enter hint, so an op added later cannot honor half the contract. **`seed` admits by tree membership**, not by the metadata it is handed: hydration passes Door rows alongside the tree's leaves, and a parked id appearing only as a Door row is still a Door — unparking it would unmount the very DOM the park preserves. Dormant while `seed` runs once at startup; live in the workspaces-rollout switch.
- **`leafMeta` covers Doors.** One map holds every leaf the Wall owns, laid out or Doored; `parked` is pure render state (`Map<id, Rect | null>`) naming the subset that keeps its DOM. Detachment is a fact about the *tree*, so **no Door record carries a metadata copy that can go stale**: `setTitle` / `updateParams` reach a Doored leaf by the same single path as a visible one, and every reader — reattach, `dor` param lookup, kill/session teardown, `buildDorSurfaces`, `dor list`, the dev-server port scan, the session save — goes through `lath.getMeta(id)`. `serializeLayout` filters `leafMeta` down to the tree's own leaves, because the persisted *layout* is the tree — a Door persists as its own row.
- **The store holds the last rect.** `doorLeaf({ park: true })` captures the leaf's current layout rect into `parked` in the same commit that removes it from the tree; LathHost unions parked ids into the same sorted leaf list and renders them at that rect with `visibility: hidden; pointer-events: none` and `data-lath-parked`, so the guest document never sees a zero-extent viewport and reattach is pixel-identical (rationale). A leaf parked before the Wall reports geometry falls back to the whole wall rect. **Keep the rect in the store, never in the adapter**: `registerEl(null)` is a ref detach, not an unmount, and React detaches whenever a callback identity changes and on every StrictMode commit — adapter-local pruning on detach silently lost every parked rect. On re-admission `admit` replays the held rect into the animator, for every admitting op and every drop target (Animation → Enter).
- **Visibility is a real signal.** A parked leaf is on screen only in the DOM sense, so `PaneProps.parked` carries it to the body and `useSurfaceVisibility(parked)` folds it together with document visibility: a minimized `ab-screencast` stays mounted and connected but stops pulling frames.
- **Who parks**: `shouldParkOnMinimize` — browser Surfaces, not terminals (a terminal's state is in the PTY and the registry replays it, so parking one would only cost memory). Both still door through `doorLeaf`.
- **Bounded.** Each parked leaf is a live document still running scripts, timers, and sockets, so `MAX_PARKED_SURFACES` (8) caps the set and `doorLeaf` trims the oldest park in the same commit. Only the **DOM** is capped — an evicted leaf is still a Door with live meta, so it simply reattaches by reloading with the latest URL/session params. The cap is generous for the minimize workflow; it exists because the workspaces-rollout switch parks a whole Workspace at a time (`docs/specs/layout.md` → Future).
- **Hydration.** A restored session's Doors have no store entry yet, so `seed` puts the persisted rows' meta back into `leafMeta` beside the tree's leaves (`leafMetaFromPersistedDoor`). That is the only place a Door's wire row is read for metadata; the runtime record is `{ id, token }`.

## The wall store and engine

Source of truth: `lib/src/components/wall/lath-wall-store.ts`; `lib/src/components/wall/lath-wall-engine.ts`. `Wall.tsx` builds the engine lazily once per mount (a `useRef` guard, so a re-render never mints a second one) and renders LathHost.

The **store** is the state machine + geometry + enter hints, and every state op / geometry query reaches it directly as `lath.store.*`; the **engine** layers presentation / vocabulary / persistence conveniences over it and **re-exports none of the store's mutators or queries**.

- **`lath-wall-store.ts`** — the sole state authority: the snapshot `{ tree, leafMeta, parked, zoomedId, revision }` behind a `useSyncExternalStore` contract (snapshot identity is stable between commits, `leafMeta`/`parked` are reused by identity when a commit does not touch them, and `revision` bumps on *every* commit including meta and zoom writes), plus the reported layout geometry and the pending enter-hint map — both side state, never in the snapshot, so neither notifies. **Every mutator applies exactly one core op**; a rejected op commits nothing, notifies nothing, and returns the failure verbatim. Geometry-dependent queries (`neighborOf`, `autoEdgeFor`, `resizeBoundary`, restore's fallback tier, `addLeaf`'s null-position autoEdge) use the rect + opts LathHost last reported via `setLayoutGeometry`, which **rejects a degenerate (zero-area) rect**: `autoEdge` on 0×0 returns `'bottom'` for every split, so a seed reading it would stack every pane vertically — strictly worse than the `!geometry` fallback (`'right'`). `LATH_LAYOUT_OPTS` (gap `PANE_GUTTER_PX` = 7; `minLeaf` 100×60) lives here as the one geometry both the store and the adapter lay out with.
- **`lath-wall-engine.ts`** — the Wall-facing handle over the store, holding only what the store does not: the animator (+ `exitMs` / `markDying` / `isDying` / the frame + wake signals; see Animation), the read projections `listPanes()` (tree pre-order + meta — read by `buildDorSurfaces`, the kill selection tail, persistence, and dev-server port correlation; **parked leaves are not visible and are not listed**) and `getMeta(id)` (which *does* resolve Doored leaves), the vocabulary maps (Edge ↔ dor direction, arrow → direction), the meta builders `terminalLeafMeta` / `browserLeafMeta` / `leafMetaFromPersistedDoor`, `shouldParkOnMinimize`, and the persistence conveniences `serializeLayout` + the two-way hydration `seed` (persisted Lath layout, else fresh panes). **It holds no selection/focus/mode/activation state.**
- All selection/focus/mode policy stays at the Wall: focus-neutral adds reduce to a selection decision (`settleAddSelection`) because nothing re-parents and nothing activates; the Cmd-Arrow swap is one `store.swapLeaves` call with **no** companion title swap (meta and registry entries follow ids); kills fade then remove (Animation → Exit); keyboard spatial nav rides `store.neighborOf` through the `WallNav` seam in `lib/src/components/wall/keyboard/types.ts`.
- Embed self-focus adoption (acceptance row 8) has no activation event to piggyback on: LathHost surfaces `focusin` inside a leaf as `onLeafFocused(id)`, and the Wall adopts it with the same passthrough/command policy a click would.

## The HTML adapter (LathHost)

Source of truth: `lib/src/components/wall/LathHost.tsx` (+ the `.lath-host` rules in `lib/src/index.css`; the pane/Door drag gesture lives in `lath-drag-controller.ts` — see "Hierarchical drag and drop").

**An adapter owns exactly three things**: mapping input into Wall coordinates (pointer position in HTML; a controller/gaze raycast against the wall plane in a Three.js adapter), applying animator frames to its scene each tick, and hosting pane content. Layout, ops, sash geometry, and animation timelines are core and shared. LathHost is a thin React component and the only non-headless part of the engine.

- One flat container; one stable `position: absolute` div per leaf, keyed by id and carrying `data-lath-leaf`. Pane content renders as ordinary React children into that div. The div moves and resizes via inline styles; it is **never re-parented, never reordered, and never unmounted** except on a remove commit (or a park eviction). **Leaf divs render in sorted-by-id DOM order, not tree order** — React reordering keyed siblings moves DOM nodes, and a moved node blurs the focused xterm inside it and reloads a moved `<iframe>`.
- Each leaf div is a 30px header slot over a filling body, plus an optional whole-leaf **overlay** slot for pointer-transparent chrome spanning header *and* body; the header slot and zoom inset both derive from `PANE_HEADER_HEIGHT_PX` in `lib/src/components/design.tsx`. All three resolve from `leafMeta.component` / `.tabComponent` through the same registry (body: `terminal` → TerminalPanel, `browser` → BrowserPanel; tab: `terminal` / `surface`; overlay: `terminal` → the spoken-alarm indicator), so leaf content resolves one way instead of one way plus a surface-kind branch. `componentsOverride` is the jsdom test seam for all three (so tests never mount real xterm). The positioned wrapper carries geometry only; header, body, and overlay live in a memoized inner unit keyed on `{ id, meta, parked, resolved components }`, so a geometry-only frame never re-renders the content.
- Sashes render from core `sashes()` geometry as sibling divs (hit area widened to 8px, cursor per axis); a drag streams a core `resize` preview from the drag-start tree with the cumulative delta and proposes a single commit on pointerup (`onCommitResize`); Escape cancels. Geometry is reported back via `store.setLayoutGeometry` **from inside the measuring layout effect, never a passive effect over the rendered size** — the Wall's seed runs in a passive effect and reads this geometry through `addLeaf`'s `autoEdge`, so only a layout effect (children-first) makes the real measured rect available at seed time rather than a lagging one. The store's zero-area rejection (above) is the backstop.
- Zoom retargets only the chosen leaf to the wall rect inset by `LATH_ZOOM_MARGIN` and elevates it above tiled/dying panes and sashes; while its animator layer is elevated, LathHost applies the blurred `LATH_ZOOM_SHADOW`. Unzoom keeps it elevated and shadowed while it shrinks back, clearing both only after the return frame settles.
- **The binding never calls `.focus()` and emits no activation events.** Gestures surface as proposals (`onCommitResize`, `onLeafFocused`, the drag callbacks) that the Wall commits.
- The selection ring and kill overlay measure leaf elements through `resolvePaneElement`, which climbs to `[data-lath-leaf]`; `WorkspaceSelectionOverlay` re-measures on every store commit (`revision` via `useSyncExternalStore`) and on every animator tick (the engine's frame signal). Same-identity re-measures snap 1:1, so while frames stream the ring tracks kills, restores, and tweens frame-accurately; its own between-panes travel is a separate JS tween ([layout.md → Ring travel](layout.md#ring-travel)), not a CSS transition.

## Animation

Source of truth: `lib/src/lib/lath/animator.ts` (core); the animator ownership in `lath-wall-engine.ts`; the enter-hint derivation in `lath-wall-store.ts`; the frame-application effects in `LathHost.tsx`. [layout.md → Animations](layout.md#animations) describes the user-visible zoom / spawn / kill behaviors this contract implements.

**Animation is core, not adapter.** The headless **animator** turns committed layout changes into presentation frames as a pure function of time (`now` is always passed in — no DOM, timers, or `Date`), so every renderer animates identically and tests assert real interpolated values against a fake clock.

- `createAnimator({ durationMs, easing? })` exposes `retarget(targets, now, enters?, { snap?, layers? })`, `markDying(id, now, { shrinkTowardBottomRight? })`, `isDying(id)`, `framesAt(now): Map<LeafId, Frame>` (`Frame = { rect, opacity, layer }`), and `settledAt(now)` (adapters stop ticking when settled). **Layers are discrete, never interpolated**: `LATH_LAYER_TILED` 0 / `LATH_LAYER_DYING` 1 / `LATH_LAYER_ELEVATED` 2, with a rising leaf entering the higher band before geometry moves and a lowering leaf staying there until the motion settles. Adapters map the bands to renderer-specific z-order.
- Default motion is the house easing (`LATH_MOTION_MS` 440ms, `cubic-bezier(0.22, 1, 0.36, 1)` solved in JS by the exported `cubicBezier`). **A caller needing a *rate* rather than a position must use the returned `Easing`'s `slope(t)`** instead of differencing successive samples, which costs a frame of lag and reports nothing at all on the first frame ([layout.md → Ring travel](layout.md#ring-travel) is the cautionary case). **A `retarget` mid-flight starts every leaf from its current interpolated frame** — interruptible by construction; no in-progress guards. `snap: true` starts leaves already settled (sash-drag commits and container resizes — hand-placed geometry must not tween), as does any retarget whose from/to frames already match.
- **Enter**: the store's mutators derive the hint internally — `addLeaf` / `restoreLeaf` / `insertLeaf` set it from the edge they actually commit (the *opposite* of the placement edge, via `oppositeEdge`, so a pane placed to the right grows from its left boundary), drained at the next retarget through `consumeEnterHints`; the leaf's frames begin collapsed against that boundary at opacity 0. This covers `addLeaf`'s null-position `autoEdge` fallback and derives reattach hints from the door token's edge. Precedence: a re-admitted parked leaf's held rect (an `EnterFrom` rect at full opacity — viewport safety over a cosmetic hint) beats an explicit `setEnterHint`, which beats a derived hint. The only current `setEnterHint` user is the auto-spawn refill (`'top-left'`, since the killed last pane shrank toward the bottom-right).
- **Exit**: removal is two-phase. The Wall calls `lath.markDying(id, { shrinkTowardBottomRight })` (freeze-and-fade in place; the last-pane kill shrinks toward its bottom-right corner), keeps the mounted terminal DOM through the fade, then in a `setTimeout(lath.exitMs)` runs `disposeSession` and commits `store.removeLeaf` — survivors tween into the reclaimed space on the resulting retarget. The finalizer bails if the leaf is already gone (superseded by a replace), and **forgets the surface ref only after the removal**, because a fading leaf is still in `listPanes()` and an earlier delete would let a `dor` projection re-mint a ref for it. `isDying` makes a second kill of the same pane a no-op; selection adoption stays a live re-read at removal time. Dying leaves get `pointer-events: none`; a dying zoomed leaf keeps its elevated inset geometry and layer while LathHost applies the animator's opacity.
- **Ownership split**: the core animator is pure and owns the dying state; the *engine* owns the animator instance (`durationMs` 0 under `motionIsInstant()` — reduced motion and Chromatic's `animate: false` in `lib/.storybook/preview.ts` run the very same code path), `exitMs`, and the frame/wake signals (`markDying` starts a fade without a store commit, so it must wake the tick loop itself); the *store* owns the enter-hint map; *LathHost* drives a rAF tick while unsettled and applies `framesAt` **imperatively** to the registered leaf divs (left/top/width/height/opacity/z-index/box-shadow/pointer-events). React keeps rendering target geometry — the memoized leaves do not re-render during a tween, and a no-deps layout effect re-asserts the current frames after any unrelated React commit so a mid-tween re-render cannot snap styles back to target. **There is no CSS entrance/exit path.**

## Pane props contract

Source of truth: `lib/src/components/wall/pane-props.ts`, `PaneWriteContext` in `wall-context.tsx`, `LathHost.tsx`.

**Every pane body / header component takes plain `PaneProps` and never sees the engine** — `TerminalPanel`, `BrowserPanel`, `AgentBrowserPanel`, `IframePanel`, `TerminalPaneHeader`, `SurfacePaneHeader`, plus `use-pane-chrome` / `use-surface-visibility`:

- **Read side**: `PaneProps` — `{ id, title, params, parked? }`. LathHost supplies the first three straight from `leafMeta`, which covers parked leaves too — a meta commit re-renders the leaf, so params stay live either way.
- **Write side**: `PaneWriteContext` (`{ setTitle(id, t), updateParams(id, patch) }`), provided by the Wall and backed by the store (`lath.store.setTitle` / `lath.store.updateParams`). The `wsPort`-refresh and render-swap flows route through the same seam. The context value is stable per mount; the `AgentBrowserPanel` controller sink captures it once.
- **Visibility**: a mounted leaf is engine-visible unless it is **parked**, so `parked` is the one non-meta pane prop (LathHost supplies it; absent means "not parked", which is right for anything rendered outside LathHost). `useSurfaceVisibility(parked)` folds it together with document visibility, so both a backgrounded window and a minimized browser Surface gate streaming while the session stays alive.
- `use-pane-chrome` registers the pane's root element in `PaneElementsContext` (so the overlays can measure it) and nothing else — there is no CSS spawn-animation to trigger.

## Persistence

Source of truth: the wire format + reader/writer (`LeafMeta`, `LathPersistedLayout`, `lathLayoutFromStore`, `isLathPersistedLayout`) in `lib/src/lib/lath/persistence.ts`; `lathLayout` / `token` in `lib/src/lib/session-types.ts`; the save in `use-session-persistence.ts` / `session-save.ts`; `persistedLathLayout` in `session-restore.ts`, consumed by `reconnect.ts`.

The Lath layout serializes as `{ version: 1, tree, leafMeta }` (`LathPersistedLayout`) — the tree is its own wire format, and `leafMeta` carries the per-leaf `{ component, tabComponent, title, params }`. It rides **inside** `PersistedSession` as the optional field `lathLayout`. Doors carry an optional restore `token`. Saves write `lathLayout` only. `leafMeta` in the STORE also covers Doored leaves, so `lathLayoutFromStore` filters it down to the tree's own leaves; each Door's live meta is materialized into its saved row instead (`use-session-persistence.ts`), so a restart cold-loads each Surface where the user left it — **a parked document never survives a restart, only a minimize**.

The session read boundary resolves the layout once: `persistedLathLayout` (`session-restore.ts`) returns the native `lathLayout` when present, else undefined. Everything downstream — the resume gate in `reconnect.ts` (leaf set must match the visible pane set), the `restoredLathLayout` prop threading, and the engine's `seed` — sees only a Lath layout; on an absent, structurally invalid, or empty layout, `seed` falls back to fresh panes.

## Testing

Source of truth: the DOM-free suites in `lib/src/lib/lath/`, the binding suites under `lib/src/components/wall/`, and `lib/src/components/Wall.test.tsx`. They pin the core algebra, rejection identity, geometry, animator, hit testing, persistence, stable DOM identity, parking, drag/resize/zoom, and Wall integration. The standalone agent-browser acceptance run covered the corresponding live flows; its evidence is retained in the rationale.

Ordering constraint: the workspace-switching stages of the **workspaces-rollout** scope (defined in [layout.md](layout.md)) build on this engine — a workspace switch under Lath is "swap which tree renders." `onApiReady` (the old tiling-api ready callback) is gone and **must not come back**: the website tutorial, its last consumer, drives off the engine-neutral `WallEvent` stream (`paneAdded` for pane creation, `selectionChange` for kb-arrows).
