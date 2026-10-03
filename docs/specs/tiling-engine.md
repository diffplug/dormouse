# Tiling Engine (Lath)

> See [glossary.md](glossary.md) for the Surface model, the `Window ⊃ Workspace ⊃ Pane ⊃ Surface` hierarchy, and the Pane / Door / baseboard / passthrough vocabulary used here.
> **Owns** the engine internals: the pure core under `lib/src/lib/lath/` (model, layout, ops, animator, hit-testing) plus the Wall binding with native motion and hierarchical DnD. Lath replaced dockview-react; that dependency is gone.
> **Defers** the interaction model on top to [layout.md](layout.md): selection, focus, modes, session lifecycle.
> Evidence behind the rules: [tiling-engine.rationale.md](tiling-engine.rationale.md).

## Why

Lath replaces dockview's split tree, resize, drag-move, maximize, and serialization, eliminating its broader model's failure modes (rationale).

## Principles and non-goals

Lath is a **headless geometry engine**: it owns the split tree, rects, animation targets, and drag hit-testing — nothing else.

- **Every operation is `(tree, args) → result`.** No listeners, no event emitters, no timing assumptions.
- **The core must never import DOM, React, or Three.js types** — tree, `layout()`, ops, hit-testing, sash geometry, and the animator are all plain-data-in, plain-data-out, so the planned Three.js adapter (the VR Window item in [remote-api.md](remote-api.md)'s staged remainder) reuses every one unchanged. LathHost is the first consumer.
- **Never give Lath a concept of selection, focus, mode, or activation** — those stay in the Wall with the (kind, id) selection pair and its policies.
- **The DOM binding never re-parents a pane's element**: layout is geometric, not structural.
- **Non-goals**: tab stacking, floating groups, popout windows (agent-browser pop-out is a separate mechanism), the mobile compositions (MobileWall does not tile), and building the Three.js adapter itself — the guarantee is only that the core stays consumable by one.

## Core model

`LathTree` is a nullable root of leaf or weighted split nodes: a `'row'` split lays children left→right, `'col'` top→bottom. **Trees are immutable**: ops return fresh trees and may share immutable nodes. Nodes are addressed by **path** (`number[]` of child indexes from the root; the root is `[]`), and **paths are ephemeral** — valid only until the next op, never persisted.

Invariants, enforced by every op and checked by `validate(tree)`:

- A split has ≥ 2 children and **never directly contains a same-direction split** — same-direction children flatten on construction, i3-style, through the shared `normalize` constructor **every structural op builds through**; `replace` and `swap` exchange leaf identities in place, which can change no direction, so they write through `replaceAtPath` alone. That flattening gives DnD its scopes: every ancestor boundary is a real, distinct drop.
- Weights within a split are finite, > 0, and normalized to sum 1.
- Leaf ids are unique. `root: null` is the empty Wall, and **no add / split / insert op accepts one** — the Wall seeds it with `leafTree(id)`, and `restore` alone reinserts into it, as the root at the fallback tier. The "always one pane visible" auto-spawn rule stays app-level.

**Zoom is never in the tree.** It is presentation state (`zoomedId` in the wall store), so the tree, every other rect, and all leaf DOM stay unchanged beneath a zoomed leaf; LathHost owns the elevated inset geometry (rationale).

Source of truth: `LathTree` / `validate` in `lib/src/lib/lath/model.ts`.

## Layout

`layout(tree, rect, opts)` is pure. Splits divide their axis by weight and round to integer pixels so children plus gaps tile the available span exactly — **adjacent panes never seam or overlap**. Weights are clamped at layout time against `minLeaf` by a per-split waterfill (children under their recursive minimum are pinned, the rest redistributes by weight); **stored weights are never rewritten by layout**. A split whose minimums exceed its span degrades to min-proportional allocation — still exact tiling, minimums honored only when feasible. **Must clamp negative dimensions to zero** across layout, node queries, and sashes. Gaps retain their configured width even when they alone exceed the container. `lib/src/lib/lath/layout.test.ts` pins waterfill redistribution and degenerate geometry.

Derived pure queries, each of which **must be called with the same `rect` + `opts` the caller renders with** or its geometry diverges from the screen:

| Query | Answers |
| --- | --- |
| `neighbors(tree, rect, id, direction, opts) → LeafId \| null` | Spatial navigation. Candidates must lie beyond or touch the leaf's edge; secondary-axis overlap preferred, then nearest edge-to-edge, tie-broken by smaller y, then x, then id. |
| `autoEdge(tree, rect, id, opts) → Edge` | Aspect-ratio split heuristic: laid-out rect wider than tall → `'right'`, else `'bottom'` (also `'right'` for a missing leaf). |
| `sashes(tree, rect, opts) → { splitPath, boundary, dir, rect }[]` | One entry per adjacent child pair of every split. `dir` is the parent split's axis (`'row'` → a vertical divider, col-resize); `rect` is the gap band between the pair, zero-thickness when `gap: 0` (the adapter widens the hit area). |
| `nodeRectAtPath(tree, rect, opts, path) → Rect \| null` | Rect of any interior node under the same geometry, walking only the root→leaf spine. |

Source of truth: `lib/src/lib/lath/layout.ts`.

## Operations

All ops are pure and synchronous, take the tree as their first argument (elided in the table), and return `{ tree: LathTree; ok: boolean }` plus op-specific fields. **On `ok: false` the returned `tree` is the input object**, on `ok: true` always a fresh one — so identity-comparison detects a rejected op, and tree identity never signals "no visual change." **Speculative evaluation is free**: sash live-resize and DnD previews run `layout(op(tree, …).tree, …)` per frame without committing (rationale).

| Operation | Behavior |
|---|---|
| `split` | Insert a new leaf beside a reference, taking half its weight. |
| `remove` | Remove a leaf and return its restore context; siblings absorb its weight proportionally. |
| `replace` / `swap` | Change leaf identities atomically, preserving geometry. |
| `move` | Remove and reinsert atomically, carrying the old weight. Back in its own split the siblings keep their proportions, so a reorder or drop-back moves no other pane; elsewhere it renormalizes alongside its new siblings. Resolve the target against the input tree and re-find it after removal as a node or adjacent child range; a target that cannot be re-found rejects. |
| `resize` | Move the visible boundary from the rendered allocation, clamped against recursive minimums; every other child keeps its rect and every weight stays positive. A fully clamped no-op still succeeds; a non-finite delta or non-integer boundary rejects. Callers pass the drag-start tree and cumulative delta. |
| `insert` | Insert a new leaf beside an edge target; reject swap targets, duplicates, empty trees, missing paths and NaN weights. |
| `restore` | Reinsert from a persisted token through the tiers below. |

`DropTarget` is either a leaf swap or an edge at an ancestor path, optionally narrowed to a contiguous child range of that split; edges give DnD its scopes. **Must normalize a range away in the committed tree**, so persistence keeps its version-1 shape; an invalid range rejects.

Source of truth: `lib/src/lib/lath/ops.ts`; `lib/src/lib/lath/drop-target.ts`.

## Hierarchical drag and drop

**Pointer events only** (`pointerdown` → `DRAG_THRESHOLD_PX` (5px) → drag; no HTML5 DnD), so drags are testable from CDP and never race React's synthetic events. **One `DragController` owns both the pane and Door gestures** — threshold, hit-test, click-suppression — built once per LathHost mount and fed header presses plus the `externalDrag` mirror; `Door.tsx` / `Baseboard.tsx` report presses only. **Must hit-test each preview and the release against the store's live tree**, including commits React has not rendered, so a background `dor split` / `dor kill` mid-drag shows up in the next preview.

`hitTest` takes a point already in Wall coordinates, plus the anchor of a slide in progress, and returns the one drop it would commit: its target, committed preview rect, and scope bounds. `dragged: null` is an external drag (a Door coming in): no `swap` candidates, previews via `insert`. **Gesture mechanics and the preview overlay are adapter concerns.**

The scope model:

- A leaf's center region yields `swap` (internal drags only, never with yourself).
- A leaf's inner edge bands — `min(0.3 × extent, 96)` px per side, the nearest in-band edge winning a corner — drop beside **the leaf**. A point in a gap attributes to the nearest leaf, so boundaries have no dead zones.
- **A slide along an edge widens the scope.** While the pointer stays on the anchor's boundary line, the scope is the smallest one spanning anchor to pointer: the leaf, a contiguous range of an ancestor's children laid along the line, or a whole ancestor sharing the line. Equal spans resolve to the innermost (rationale). A slide keeps its edge through the corner bands it crosses; leaving the line drops the anchor.
- **Every drop's `previewRect` is the exact rect it would commit** — a speculative `move` (or `insert`) plus `layout`, never a heuristic hint zone. Rejected ops and beside-itself no-ops (layout identical to current) yield no drop.

Adapter gesture (LathHost):

- **Start** on a leaf's header slot, primary button only, bailing on buttons/inputs/contenteditable so header chrome keeps working. **Never while zoomed or during a sash drag** — the two are mutually exclusive. Grabbing a header fires its press-time click path first, so a drag begins from passthrough on that pane; accepted quirk (rationale).
- **During**: the dragged leaf dims to 0.6; one `data-lath-drop-preview` overlay draws the chosen candidate's rect in the selection color; hit-testing is rAF-coalesced and flushed on release (`lib/src/components/wall/LathHost.test.tsx`); **must anchor a slide only where the pointer pauses on an edge drop**, never the dragged pane's own rejected edge, so sweeping a header along the header row drops beside one pane at a time (rationale); Escape, pointer cancellation, and window blur cancel; the click, and a double-click's dblclick, the browser synthesizes on pointerup are swallowed in the capture phase.
- **Drops surface as proposals the Wall commits**: `onDragStart(id)` (selection moves onto the dragged pane, covering the drag-while-door-selected case), `onProposeMove(id, target)` (→ `moveLeaf`, then select), and `onProposeMinimize(id)` when released below the container (→ `minimizePane`, token and all). Committed moves tween via the animator.

**Door drag-out** runs the same machinery with `dragged: null`. A `Door` press reports its start point (`onDoorDragStart(item, press)`) and the Wall puts LathHost into external-drag mode at once (`externalDrag={ id, startX, startY }`); below the threshold the press is a plain click (reattach), above it the chip stays put in the baseboard. A drop on a candidate removes the Door and `insertLeaf`s the surface there with an enter hint from the target edge — **the token is not consulted, because the user chose the position**. A drop on nothing, Escape, a sub-threshold release, or a drop back onto the baseboard leaves the Door in place.

**Must delegate Workspace-strip pane drops to `docs/specs/layout.md` → Moving Surfaces between Workspaces** before local hit testing; cross-Wall adoption remounts the leaf.

Source of truth: `createDragController` in `lib/src/components/wall/lath-drag-controller.ts`; the drag callbacks in `lib/src/components/Wall.tsx`.

## Restore tokens (Doors)

**Must persist `RestoreToken` as the Door's sole restore payload.** Its canonical fields and capture rules live beside `remove` in `lib/src/lib/lath/ops.ts`. Legacy tokens without sibling-subtree context retain the older leaf-neighbor behavior when exact restoration fails. Root-leaf removals can reach only fallback. `restore` applies three tiers from the Wall's `handleReattach`:

1. **exact** — the fingerprinted context still exists around `siblingId`: reinsert at the original index and weight, existing siblings shrinking proportionally;
2. **neighbor** — the sibling still exists: split beside it on the original edge;
3. **fallback** — split beside `opts.fallbackRef` via `autoEdge`, or `'right'` with no rect. Restoring into an empty tree makes the leaf the root.

- A leaf removed from a two-child split whose survivor is a single leaf **always degrades to neighbor** — the collapse erases the fingerprinted parent, and neighbor reproduces the same position at 50/50 rather than the original weights.
- A survivor that is a split subtree keeps **exact**, targeted by `siblingLeafIds` / `siblingFingerprint`, so `A | (B over C)` restores beside the whole `B/C` column rather than inside it — **including after that subtree flattened into its grandparent**, found as a child range; a changed group degrades to neighbor.
- **Must supply a live `fallbackRef` when exact/neighbor tiers fail in a nonempty tree**; otherwise restore returns `ok: false`.

A parked leaf still carries a token: parking decides whether DOM survives, the token decides where the leaf lands.

Source of truth: `RestoreToken` / `restore` in `lib/src/lib/lath/ops.ts`.

## Parked leaves

A **parked** leaf is mounted by the adapter but absent from the split tree: its DOM survives while it lays out nothing, paints nothing, and takes no input. It exists for Surfaces whose state lives *in the DOM* — an `<iframe>`'s document, a screencast canvas — where a plain remove turns reattach into a reload.

**Detaching and parking are separate things.** Every minimize doors, regardless of Surface kind, because the store stays the authority for a Doored Surface's live title and params; only `{ park: true }` also keeps the DOM.

| Store op | Tree | Meta | DOM |
| --- | --- | --- | --- |
| `doorLeaf(id)` | out | kept | unmounted |
| `doorLeaf(id, { park: true })` | out | kept | **mounted** — browser and Tool Surfaces |
| `addDoor(id, meta)` | never in | registered | none — a Surface **born minimized**, with no pane to detach (`dor split` / `dor ensure` targeting another Door) |
| `removeLeaf(id)` | out | destroyed | unmounted — a kill |
| `forgetLeaf(id)` | — | destroyed | unmounted if parked — destroys a Door |

- **Parking must be one commit** — an id absent from both the tree and `parked` for even one render unmounts the leaf and loses its DOM state. Every re-admitting op (`addLeaf`, `restoreLeaf`, `insertLeaf`, `replaceLeaf`, `seed`) unparks in that same commit through the one shared `admit` helper, which also seeds the enter hint. **`seed` admits by tree membership**, never by the metadata it is handed (rationale). **`seed` runs once per Wall mount**, so a Workspace switch — which mounts nothing — never re-seeds.
- **One `leafMeta` map holds every leaf the Wall owns**, laid out or Doored; `parked` is pure render state (`Map<id, Rect | null>`) naming the subset that keeps its DOM. Detachment is a fact about the *tree*, so **no Door record carries a metadata copy that can go stale** — `setTitle` / `updateParams` / `setMeta` reach a Doored leaf by the same single path as a visible one, and every reader goes through `lath.getMeta(id)` (rationale). `serializeLayout` filters `leafMeta` to the tree's own leaves; a Door persists as its own row.
- **The store holds a parked leaf's last rect, never the adapter** — `registerEl(null)` is a ref detach, not an unmount (rationale). `doorLeaf({ park: true })` captures the rect in the commit that removes the leaf from the tree, `admit` replays it into the animator on re-admission (Animation → Enter), and LathHost renders parked ids there behind `visibility: hidden; pointer-events: none` and `data-lath-parked`, so the guest never sees a zero-extent viewport (rationale). A leaf parked before the Wall reports geometry falls back to the whole wall rect.
- **Parked is a visibility signal, not just a layout fact** — it reaches the body as `PaneProps.parked` (Pane props contract), so a minimized `agent-browser-screencast` stays mounted, releases viewer resources, and retains its daemon session.
- **Must park browser and Tool Surfaces** via `shouldParkOnMinimize`, unlike terminals, whose persistent xterm instance remounts without replay ([glossary.md → View](glossary.md#view)).
- **Never evict parked browser or Tool DOM to enforce a count limit.** Parked documents remain mounted until reattachment or Surface destruction; retention is unbounded. Tests: `lib/src/components/wall/LathHost.test.tsx`. (rationale) Parking budgets **minimized browser and Tool Surfaces only**: a hidden Workspace parks nothing — its leaves stay mounted and merely stop painting (`docs/specs/layout.md` → Workspaces).
- **Hydration.** A restored session's Doors have no store entry yet, so `seed` puts the persisted rows' meta into `leafMeta` beside the tree's leaves (`leafMetaFromPersistedDoor`) — the only place a Door's wire row is read for metadata. The runtime record is `{ id, token }`.

Source of truth: `minimizePane` in `lib/src/components/Wall.tsx`; `shouldParkOnMinimize` in `lib/src/components/wall/lath-wall-engine.ts`; `doorLeaf` in `lib/src/components/wall/lath-wall-store.ts`.

## The wall store and engine

The **store** is the state machine + geometry + enter hints, reached directly as `lath.store.*`; the **engine** layers presentation / vocabulary / persistence conveniences over it and **re-exports none of the store's mutators or queries**. `Wall.tsx` builds the engine lazily once per mount (a `useRef` guard, so a re-render never mints a second) and renders LathHost.

**`lath-wall-store.ts` is the sole state authority.** Its snapshot `{ tree, leafMeta, parked, zoomedId, revision }` sits behind a `useSyncExternalStore` contract: identity stable between commits, `leafMeta`/`parked` reused by identity when a commit does not touch them, `revision` bumping on *every* commit including meta and zoom writes. The reported layout geometry and the pending enter-hint map are side state, never in the snapshot, so neither notifies.

- **Every tree mutation commits atomically**; a rejected op commits nothing, notifies nothing, and returns the failure verbatim.
- Geometry-dependent queries (`neighborOf`, `autoEdgeFor`, `resizeBoundary`, restore's fallback tier, `addLeaf`'s null-position autoEdge) read the rect + opts LathHost last reported via `setLayoutGeometry`, which **must reject zero-area reports**, retaining the last valid geometry or using the no-geometry fallback before the first valid report (rationale).
- `LATH_LAYOUT_OPTS` (gap `PANE_GUTTER_PX` = 7; `minLeaf` 100×60) lives here as the one geometry both the store and the adapter lay out with.

**`lath-wall-engine.ts` is the Wall-facing handle**, holding only what the store does not — the animator and its `exitMs` / `markDying` / `isDying` / frame + wake signals, the vocabulary maps (Edge ↔ dor direction, arrow → direction), the meta builders (`terminalLeafMeta` / `browserLeafMeta` / `leafMetaFromPersistedDoor`), `shouldParkOnMinimize`, and the persistence conveniences `serializeLayout` / `seed` — and **no selection/focus/mode/activation state**. Two projection rules bind its readers: `listPanes()` is tree pre-order + meta, so **parked leaves are not visible and are not listed**, while `getMeta(id)` *does* resolve Doored leaves.

**All selection/focus/mode policy stays at the Wall** ([layout.md](layout.md)); three consequences bind editors here. Within one Wall, nothing re-parents or activates, so a focus-neutral add reduces to a selection decision (`settleAddSelection`). The Cmd-Arrow swap is one `store.swapLeaves` call with **no** companion title swap — meta and registry entries follow ids. And **embed self-focus adoption rides `focusin`** (acceptance row 8), which LathHost surfaces as `onLeafFocused(id)` for the Wall to adopt like a click, there being no activation event to piggyback on. Spatial nav reaches `store.neighborOf` through the `WallNav` seam in `lib/src/components/wall/keyboard/types.ts`.

Source of truth: `lib/src/components/wall/lath-wall-store.ts`; `lib/src/components/wall/lath-wall-engine.ts`.

## The HTML adapter (LathHost)

**An adapter owns exactly three things**: mapping input into Wall coordinates, applying animator frames to its scene each tick, and hosting pane content. Layout, ops, sash geometry, and animation timelines are core and shared; LathHost is the engine's only non-headless part.

- One flat container; one stable `position: absolute` div per leaf, keyed by id, carrying `data-lath-leaf`, moved and resized by inline styles, hosting pane content as ordinary React children. **Must never re-parent, reorder, or unmount the div within one Wall** except on a remove commit, and **leaf divs render in sorted-by-id DOM order, not tree order** — reordering keyed siblings moves DOM nodes, blurring the xterm inside one and reloading a moved `<iframe>`.
- Each leaf div is a 30px header slot over a filling body, plus an optional whole-leaf **overlay** slot for chrome spanning header *and* body; header slot and zoom inset both derive from `PANE_HEADER_HEIGHT_PX` in `lib/src/components/design.tsx`. **All three slots resolve from `leafMeta.component` / `.tabComponent` through one registry, never a surface-kind branch beside it**; an unregistered key renders that slot empty, and `componentsOverride` is the jsdom test seam for all three. **The positioned wrapper carries geometry only** — header, body, and overlay live in a memoized inner unit keyed on `{ id, meta, parked, resolved components }`, so a geometry-only frame never re-renders the content.
- Sashes render from core `sashes()` geometry as sibling divs (hit area widened to 8px, cursor per axis); a drag streams a core `resize` preview from the drag-start tree with the cumulative delta and proposes one commit on pointerup (`onCommitResize`). **Must accept primary-button presses only and take the final delta from the release coordinates**; Escape, pointer cancellation, window blur, or a concurrent tree or zoom change cancels. **Geometry is reported through `store.setLayoutGeometry` from inside the measuring layout effect, never a passive effect over the rendered size** (rationale); the store's zero-area rejection is the backstop.
- Zoom retargets only the chosen leaf to the wall rect inset by `LATH_ZOOM_MARGIN` (half a pane header) and elevates it above tiled/dying panes and sashes, applying the blurred `LATH_ZOOM_SHADOW` while elevated. Unzoom keeps both until the return frame settles.
- **The binding never calls `.focus()` and emits no activation events.** Gestures surface as proposals (`onCommitResize`, `onLeafFocused`, the drag callbacks) that the Wall commits.
- Terminal Context renders above the tiled leaves. **Its placer runs inside each paint, before `notifyFrames`**, so the ring measures the helper where it is painted; `docs/specs/layout.md` → Header context menu owns the context.
- The selection ring and kill overlay measure leaf elements through `resolvePaneElement`, which climbs to `[data-lath-leaf]`; `WorkspaceSelectionOverlay` re-measures on every store commit (`revision`) and every animator tick, and **same-identity re-measures snap 1:1**, so the ring tracks kills, restores, and tweens frame-accurately ([layout.md → Ring travel](layout.md#ring-travel) owns its between-panes travel, a JS tween rather than a CSS transition).

Source of truth: `LathHost` in `lib/src/components/wall/LathHost.tsx`; the `.lath-host` rules in `lib/src/index.css`.

## Animation

**Animation is core, not adapter.** The headless **animator** turns committed layout changes into presentation frames as a pure function of time (`now` is always passed in — no DOM, timers, or `Date`), so every renderer animates identically and tests assert real interpolated values against a fake clock. [layout.md → Animations](layout.md#animations) owns the user-visible zoom / spawn / kill behaviors this implements.

- **Must stop ticking once `settledAt(now)` is true.** The canonical animator interface and frame shape are `LathAnimator` / `Frame` in `lib/src/lib/lath/animator.ts`. **Layers are discrete, never interpolated**: a rising leaf adopts the higher band before moving; a lowering leaf keeps it until settled. Adapters map `LATH_LAYER_TILED`, `LATH_LAYER_DYING`, and `LATH_LAYER_ELEVATED` to renderer z-order.
- Default motion is the house easing (`LATH_MOTION_MS` 440ms, `cubic-bezier(0.22, 1, 0.36, 1)` solved in JS by `cubicBezier`); `createAnimator` takes a bare `t → eased` and hands no easing back. **A caller needing a *rate* must read `slope(t)` off the `Easing` `cubicBezier` returns — `LATH_EASING` for house motion** — never differences of successive samples (rationale; [layout.md → Ring travel](layout.md#ring-travel) is the cautionary case).
- **A `retarget` mid-flight starts every leaf from its current interpolated frame** — interruptible by construction, no in-progress guards. `snap: true` starts leaves already settled (sash-drag commits, container resizes: hand-placed geometry must not tween), as does a retarget whose from/to frames already match.
- **Must derive add/insert hints from the opposite placement edge and reattach hints from the opposite token edge.** **Must prefer a parked leaf's held rect over an explicit hint, and an explicit hint over a derived hint**; held rects start at full opacity, edge hints collapsed at opacity 0. `consumeEnterHints` drains hints at retarget. Auto-spawn alone overrides entry with `'top-left'`. Capture and precedence mechanics live at `deriveEnterHint` / `admit` in `lib/src/components/wall/lath-wall-store.ts` (rationale).
- **Exit is two-phase.** The Wall's `lath.markDying(id, { shrinkTowardBottomRight })` freezes and fades the leaf in place — the last-pane kill shrinking toward its bottom-right corner — with its terminal DOM still mounted; a `setTimeout(lath.exitMs)` then commits `store.removeLeaf` before `disposeSession`, and survivors tween into the reclaimed space on the resulting retarget. The finalizer bails if the leaf is already gone (superseded by a replace) and **forgets the surface ref only after the removal** (rationale). `isDying` makes a second kill a no-op. Dying leaves get `pointer-events: none`; a dying zoomed leaf keeps its elevated inset geometry and layer while LathHost applies the animator's opacity.
- **Ownership split**: the core animator is pure and owns the dying state; the *engine* owns the animator instance, `exitMs`, and the frame/wake signals (`markDying` fades without a store commit, so it wakes the tick loop itself); the *store* owns the enter-hint map; *LathHost* drives a rAF tick while unsettled and applies `framesAt` **imperatively** to the leaf divs (left/top/width/height/opacity/z-index/box-shadow/pointer-events). **Reduced motion is the same code path**, not a branch — `durationMs` 0 under `motionIsInstant()`, which the visual-snapshot `animate: false` in `lib/.storybook/preview.ts` also sets. **A no-deps layout effect re-asserts the current frames after any unrelated React commit**, so a mid-tween re-render cannot snap styles back to target (rationale). **There is no CSS entrance/exit path.**

Source of truth: `createAnimator` in `lib/src/lib/lath/animator.ts`; the animator ownership in `lib/src/components/wall/lath-wall-engine.ts`.

## Pane props contract

**Every pane body / header component takes plain `PaneProps` and never sees the engine**, `use-pane-chrome` / `use-surface-visibility` included:

- **Read side**: `PaneProps` — `{ id, title, params, parked? }`, supplied by LathHost straight from `leafMeta`, parked leaves included; a meta commit re-renders the leaf, so params stay live either way.
- **Write side**: `PaneWriteContext` (`{ setTitle(id, t), updateParams(id, patch) }`), provided by the Wall over the store (`lath.store.setTitle` / `lath.store.updateParams`); the `dor` params refresh and render-swap flows route through the same seam. The value is stable per mount; the `AgentBrowserPanel` controller sink captures it once.
- **Visibility**: a mounted leaf is engine-visible unless **parked**, so `parked` is the one non-meta pane prop and absent means "not parked" — right for anything rendered outside LathHost. `useSurfaceVisibility(parked)` folds it with document visibility and the Wall's Workspace being the visible one (`docs/specs/layout.md` → "Workspaces"), so a backgrounded window, a hidden Workspace, and a minimized browser or Tool Surface all gate streaming while the session stays alive.
- **Terminal sizing**: `TerminalResizeContext` gates fitting; `docs/specs/layout.md` → "Animations" owns the rule.
- `use-pane-chrome` registers the pane's root element in `PaneElementsContext`, for the overlays to measure, and nothing else — there is no CSS spawn-animation to trigger.

Source of truth: `lib/src/components/wall/pane-props.ts`; `PaneWriteContext` in `lib/src/components/wall/wall-context.tsx`.

## Persistence

The versioned Lath layout rides inside `PersistedSession`, and saves write only the native Lath layout. Store metadata also covers Doored leaves, so `lathLayoutFromStore` filters it to tree members and the save path materializes each Door's live metadata separately. Every leaf's metadata goes out through `persistableLeafMeta`: **a Tool's derived browser fields are stripped and a Tool still awaiting approval persists as a plain terminal** (`docs/specs/dor-tool.md` → Persistence and hosts). A restart therefore cold-loads every Surface where the user left it, a Tool as the terminal running its command — **a parked document never survives a restart, only a minimize**.

**The session read boundary resolves the layout once**: `persistedLathLayout` returns the native `lathLayout` only after validating node shapes, tree invariants, and valid metadata for exactly its leaves; otherwise undefined. `lib/src/lib/lath/persistence.test.ts` pins rejection and `lib/src/components/wall/lath-wall-engine.test.ts` pins recovery. **Both recovery paths then gate on the layout's leaf set matching the visible pane set** — the resume gate in `reconnect.ts`, the cold path in `session-restore.ts` — with the `restoredLathLayout` prop and the engine's `seed` seeing only a Lath layout. An absent, rejected, or empty one falls back to fresh panes, except that **a cold restore holding a visible Tool pane must synthesize a valid single-row layout from the pane projection instead**, dropping browser panes, so Tool identity and commands survive corrupt geometry. Pinned through engine hydration by `lib/src/lib/session-restore.test.ts`.

Source of truth: `lathLayoutFromStore` in `lib/src/lib/lath/persistence.ts`; the save in `lib/src/components/wall/use-session-persistence.ts`; `persistedLathLayout` in `lib/src/lib/session-restore.ts`, consumed by `lib/src/lib/reconnect.ts`.

## Testing

Ordering constraint: the Workspace model ([layout.md](layout.md) → Workspaces) runs one engine instance per mounted Wall, never a shared one. `onApiReady` (the old tiling-api ready callback) is gone and **must not come back**: its last consumer, the website tutorial, drives off the engine-neutral `WallEvent` stream (`paneAdded`, `selectionChange`).

Source of truth: the DOM-free suites in `lib/src/lib/lath/`, the binding suites under `lib/src/components/wall/`, and `lib/src/components/Wall.test.tsx`; live acceptance evidence is retained in the rationale.
