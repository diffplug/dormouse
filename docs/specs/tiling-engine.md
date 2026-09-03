# Tiling Engine (Lath)

> See [glossary.md](glossary.md) for the Surface model, the `Window ⊃ Workspace ⊃ Pane ⊃ Surface` hierarchy, and the Pane / Door / baseboard / passthrough vocabulary used here.
> **Owns** the engine internals: the pure core under `lib/src/lib/lath/` (model, layout, ops, animator, hit-testing) plus the Wall binding with native motion and hierarchical DnD. Lath replaced dockview-react; that dependency is gone.
> **Defers** the interaction model on top to [layout.md](layout.md): selection, focus, modes, session lifecycle.
> Evidence behind the rules: [tiling-engine.rationale.md](tiling-engine.rationale.md).

## Why

Dormouse needed only dockview's split tree, resize, drag-move, maximize, and serialization; the rules below eliminate the five failure modes its broader model introduced (rationale).

## Principles and non-goals

Lath is a **headless geometry engine**: it owns the split tree, rects, animation targets, and drag hit-testing — nothing else.

- **Every operation is `(tree, args) → result`.** No listeners, no event emitters, no timing assumptions.
- **The core must never import DOM, React, or Three.js types** — tree, `layout()`, ops, hit-testing, sash geometry, and the animator are all plain-data-in, plain-data-out, so the planned Three.js adapter (the VR Window item in [remote-api.md](remote-api.md)'s staged remainder) reuses every one unchanged. LathHost is the first consumer.
- **Never give Lath a concept of selection, focus, mode, or activation** — those stay in the Wall with the (kind, id) selection pair and its policies.
- **The DOM binding never re-parents a pane's element**: layout is geometric, not structural.
- **Non-goals**: tab stacking, floating groups, popout windows (agent-browser pop-out is a separate mechanism), the mobile compositions (MobileWall does not tile), and building the Three.js adapter itself — the guarantee is only that the core stays consumable by one.

## Core model

`LathTree` is a nullable root of leaf or weighted split nodes: a `'row'` split lays children left→right, `'col'` top→bottom. **Trees are immutable**: ops return fresh nodes along the mutated path and share structure elsewhere. Nodes are addressed by **path** (`number[]` of child indexes from the root; the root is `[]`), and **paths are ephemeral** — valid only until the next op, never persisted.

Invariants, enforced by every op and checked by `validate(tree)`:

- A split has ≥ 2 children and **never directly contains a same-direction split** — same-direction children flatten on construction, i3-style, through the shared `normalize` constructor every op builds through. That flattening gives DnD its depth semantics: every ancestor boundary is a real, distinct drop level.
- Weights within a split are > 0 and normalized to sum 1.
- Leaf ids are unique. `root: null` is the empty Wall, and **there is no op for inserting into an empty tree** — the Wall seeds one with `leafTree(id)`. The "always one pane visible" auto-spawn rule stays app-level.

**Zoom is never in the tree.** It is presentation state (`zoomedId` in the wall store), so the tree, every other rect, and all leaf DOM stay unchanged beneath a zoomed leaf; LathHost owns the elevated inset geometry (rationale).

Source of truth: `LathTree` / `validate` / `normalize` / `leafTree` in `lib/src/lib/lath/model.ts`.

## Layout

`layout(tree, rect, opts)` is pure. Splits divide their axis by weight and round to integer pixels so children plus gaps tile the span exactly — **adjacent panes never seam or overlap**. Weights are clamped at layout time against `minLeaf` by a per-split waterfill (children under their recursive minimum are pinned, the rest redistributes by weight); **stored weights are never rewritten by layout**. A split whose minimums exceed its span degrades to min-proportional allocation — still exact tiling, minimums honored only when feasible. Zero/negative rects yield zero-size rects, never a crash.

Derived pure queries, each of which **must be called with the same `rect` + `opts` the caller renders with** or its geometry diverges from the screen:

| Query | Answers |
| --- | --- |
| `neighbors(tree, rect, id, direction, opts) → LeafId \| null` | Spatial navigation. Candidates must lie strictly beyond the leaf's edge; secondary-axis overlap preferred, then nearest edge-to-edge, tie-broken by smaller y, then x, then id. |
| `autoEdge(tree, rect, id, opts) → Edge` | Aspect-ratio split heuristic: laid-out rect wider than tall → `'right'`, else `'bottom'` (also `'right'` for a missing leaf). |
| `sashes(tree, rect, opts) → { splitPath, boundary, dir, rect }[]` | One entry per adjacent child pair of every split. `dir` is the parent split's axis (`'row'` → a vertical divider, col-resize); `rect` is the gap band between the pair, zero-thickness when `gap: 0` (the adapter widens the hit area). |
| `nodeRectAtPath(tree, rect, opts, path) → Rect \| null` | Rect of any interior node under the same geometry, walking only the root→leaf spine. |

Source of truth: `lib/src/lib/lath/layout.ts`.

## Operations

All ops are pure and synchronous, take the tree as their first argument (elided in the table), and return `{ tree: LathTree; ok: boolean }` plus op-specific fields. **On `ok: false` the returned `tree` is the input object**, on `ok: true` always a fresh one — so identity-comparison detects a rejected op, and tree identity never signals "no visual change." **Speculative evaluation is free**: sash live-resize and DnD previews run `layout(op(tree, …).tree, …)` per frame without committing (rationale).

| Op | Notes |
| --- | --- |
| `split(at, edge, newId)` | Inserts `newId` beside `at`, extending the parent split when directions match (flatten invariant) or nesting a new one. The new leaf takes half of `at`'s weight. |
| `remove(id)` | Siblings absorb the weight proportionally; single-child splits collapse and re-flatten. Returns a `RestoreToken`. |
| `replace(oldId, newId)` | Atomic identity swap in place — no transient add/remove states (the `dor iframe` replace-untouched-terminal case). |
| `move(id, target: DropTarget)` | Remove + insert as one op; the leaf carries its old normalized weight into the new context. `target.path` is read against the input tree, then re-found post-removal by surviving leaf set — falling back to the target's first surviving leaf if that subtree dissolved. |
| `swap(a, b)` | Leaf identity swap (drag-onto-center; the Cmd-Arrow swap). `a === b` is rejected. |
| `resize(splitPath, boundary, deltaPx, rect, opts)` | Adjusts the weights of children `boundary`/`boundary + 1`, clamped so neither drops below its recursive `minLeaf` span, with an epsilon floor keeping both strictly positive (a `minLeaf` of 0 may render 0px but never stores weight 0). A fully-clamped no-op is still `ok: true`. Streamed during a sash drag: pass the *original* tree each frame with a cumulative delta; the final tree commits on pointerup. |
| `insert(id, target: DropTarget, weight = 0.5)` | The insert half of `move`, public for external (Door) drops: a NEW leaf at a drop target carrying `weight`, clamped into (0,1). Swap targets, existing ids, empty trees, and paths off the tree are rejected. |
| `restore(token, opts?)` | Reinserts a removed leaf, best effort (below). |

`DropTarget` is either a leaf swap or an edge at an ancestor path; the latter gives DnD its depth levels.

Source of truth: `lib/src/lib/lath/ops.ts`.

## Hierarchical drag and drop

**Pointer events only** (`pointerdown` → 5px `DRAG_THRESHOLD` → drag; no HTML5 DnD), so drags are testable from CDP and never race React's synthetic events. **One `DragController` owns both the pane and Door gestures** — threshold, hit-test, click-suppression — built once per LathHost mount and fed header presses plus the `externalDrag` mirror; `Door.tsx` / `Baseboard.tsx` report presses only. **A live drag re-reads the store's tree each frame**, so a background `dor split` / `dor kill` mid-drag shows up in the next preview.

`hitTest` takes a point already in Wall coordinates and returns drop candidates innermost→outermost, each carrying its target, committed preview rect, and depth. `dragged: null` is an external drag (a Door coming in): no `swap` candidates, previews via `insert`. **Gesture mechanics and the preview overlay are adapter concerns.**

The depth model:

- A leaf's center region yields `swap` (internal drags only, never with yourself).
- A leaf's inner edge bands — `min(0.3 × extent, 96)` px per side, the nearest in-band edge winning a corner — yield `edge` targets **at the leaf's level**. A point in a gap attributes to the nearest leaf, so boundaries have no dead zones.
- When the hovered leaf's edge coincides (≤ 0.5px) with an ancestor boundary, `hitTest` also yields `edge` targets **at each ancestor level** — "beside this entire column," up to the root.
- **Every candidate's `previewRect` is the exact rect the drop would commit** — a speculative `move` (or `insert`) plus `layout`, never a heuristic hint zone. Rejected ops, beside-itself no-ops (layout identical to current), and duplicate ancestor levels are filtered out, so every surviving depth is a genuinely different drop (rationale).
- Resolution starts at the innermost candidate; the **scroll wheel** cycles outward through `depth`, wrapping, scroll-up backward. The list resets to innermost whenever its target set changes.

Adapter gesture (LathHost):

- **Start** on a leaf's header slot, primary button only, bailing on buttons/inputs/contenteditable so header chrome keeps working. **Never while zoomed or during a sash drag** — the two are mutually exclusive. Grabbing a header fires its press-time click path first, so a drag begins from passthrough on that pane; accepted quirk (rationale).
- **During**: the dragged leaf dims to 0.6; one `data-lath-drop-preview` overlay draws the chosen candidate's rect in the selection color; hit-testing is rAF-coalesced; Escape cancels; the click the browser synthesizes on pointerup is swallowed in the capture phase.
- **Drops surface as proposals the Wall commits**: `onDragStart(id)` (selection moves onto the dragged pane, covering the drag-while-door-selected case), `onProposeMove(id, target)` (→ `moveLeaf`, then select), and `onProposeMinimize(id)` when released below the container (→ `minimizePane`, token and all; the Wall gates it on `showBaseboard`, so it no-ops when the baseboard is hidden). Committed moves tween via the animator.

**Door drag-out** runs the same machinery with `dragged: null`. A `Door` press reports its start point (`onDoorDragStart(item, press)`) and the Wall puts LathHost into external-drag mode at once (`externalDrag={ id, startX, startY }`); below the threshold the press is a plain click (reattach), above it the chip stays put in the baseboard. A drop on a candidate removes the Door and `insertLeaf`s the surface there with an enter hint from the target edge — **the token is not consulted, because the user chose the position**. A drop on nothing, Escape, a sub-threshold release, or a drop back onto the baseboard leaves the Door in place.

Source of truth: `hitTest` in `lib/src/lib/lath/hit-test.ts`; `createDragController` in `lib/src/components/wall/lath-drag-controller.ts`; the drag callbacks in `lib/src/components/Wall.tsx`; presses in `lib/src/components/Door.tsx` / `lib/src/components/Baseboard.tsx`.

## Restore tokens (Doors)

`remove` returns a JSON-serializable `RestoreToken` of the leaf's ancestry: `siblingId` (the nearest same-parent sibling leaf it sat beside), `siblingLeafIds` / `siblingFingerprint` (that sibling's leaf set and structure fingerprint, when it is itself a split subtree), `edge` (such that neighbor-tier restore is `split(siblingId, edge, leafId)`), its normalized `weight` and child `index`, and a structure-only `fingerprint` — kinds, dirs, leaf ids, no weights — of the parent split *post-removal*. `restore` applies three tiers, driven from the Wall's `handleReattach`:

1. **exact** — the fingerprinted context still exists around `siblingId`: reinsert at the original index and weight, existing siblings shrinking proportionally;
2. **neighbor** — the sibling still exists: split beside it on the original edge;
3. **fallback** — split beside `opts.fallbackRef` via `autoEdge`, or `'right'` with no rect. Restoring into an empty tree makes the leaf the root.

- A leaf removed from a two-child split whose survivor is a single leaf **always degrades to neighbor** — the collapse erases the fingerprinted parent, and neighbor reproduces the same position at 50/50 rather than the original weights.
- A survivor that is a split subtree keeps **exact**, targeted by `siblingLeafIds` / `siblingFingerprint`, so `A | (B over C)` restores beside the whole `B/C` column rather than inside it.
- **A token whose sibling is gone and whose caller supplies no `fallbackRef` fails with `ok: false`** — callers own picking a live reference.

Tokens serialize with Doors (`PersistedDoor.token`) as the sole restore payload. A parked leaf still carries one: parking decides whether the DOM survives, the token decides where the leaf lands.

Source of truth: `RestoreToken` / `restore` in `lib/src/lib/lath/ops.ts`.

## Parked leaves

A **parked** leaf is mounted by the adapter but absent from the split tree: its DOM survives while it lays out nothing, paints nothing, and takes no input. It exists for Surfaces whose state lives *in the DOM* — an `<iframe>`'s document, a screencast canvas — where a plain remove turns reattach into a reload.

**Detaching and parking are separate things.** Every minimize doors, terminal or browser, because the store stays the authority for a Doored Surface's live title and params; only `{ park: true }` also keeps the DOM.

| Store op | Tree | Meta | DOM |
| --- | --- | --- | --- |
| `doorLeaf(id)` | out | kept | unmounted |
| `doorLeaf(id, { park: true })` | out | kept | **mounted** — browser Surfaces only |
| `addDoor(id, meta)` | never in | registered | none — a Surface **born minimized**, with no pane to detach (`dor split` / `dor ensure` targeting another Door) |
| `removeLeaf(id)` | out | destroyed | unmounted — a kill |
| `forgetLeaf(id)` | — | destroyed | unmounted if parked — destroys a Door |

- **Parking must be one commit** — an id absent from both the tree and `parked` for even one render unmounts the leaf and loses its DOM state. Every re-admitting op (`addLeaf`, `restoreLeaf`, `insertLeaf`, `replaceLeaf`, `seed`) unparks in that same commit through the one shared `admit` helper, which also seeds the enter hint. **`seed` admits by tree membership**, never by the metadata it is handed (rationale). Dormant while `seed` runs once at startup; live in the workspaces-rollout switch.
- **One `leafMeta` map holds every leaf the Wall owns**, laid out or Doored; `parked` is pure render state (`Map<id, Rect | null>`) naming the subset that keeps its DOM. Detachment is a fact about the *tree*, so **no Door record carries a metadata copy that can go stale** — `setTitle` / `updateParams` reach a Doored leaf by the same single path as a visible one, and every reader goes through `lath.getMeta(id)` (rationale). `serializeLayout` filters `leafMeta` to the tree's own leaves; a Door persists as its own row.
- **The store holds a parked leaf's last rect, never the adapter** — `registerEl(null)` is a ref detach, not an unmount (rationale). `doorLeaf({ park: true })` captures the rect in the commit that removes the leaf from the tree, `admit` replays it into the animator on re-admission (Animation → Enter), and LathHost renders parked ids there behind `visibility: hidden; pointer-events: none` and `data-lath-parked`, so the guest never sees a zero-extent viewport (rationale). A leaf parked before the Wall reports geometry falls back to the whole wall rect.
- **Parked is a visibility signal, not just a layout fact** — it reaches the body as `PaneProps.parked` (Pane props contract), so a minimized `ab-screencast` stays mounted and connected but stops pulling frames.
- **Who parks**: `shouldParkOnMinimize` — browser Surfaces, not terminals, whose state is in the PTY and replayed by the registry.
- **Bounded.** `MAX_PARKED_SURFACES` (8) caps the set and `doorLeaf` trims the oldest park in the same commit, because each parked leaf is a live document still running scripts, timers, and sockets. Only the **DOM** is capped: an evicted leaf is still a Door with live meta and reattaches by reloading with the latest URL/session params. The cap is sized for the workspaces-rollout switch, which parks a whole Workspace at a time (`docs/specs/layout.md` → Future).
- **Hydration.** A restored session's Doors have no store entry yet, so `seed` puts the persisted rows' meta into `leafMeta` beside the tree's leaves (`leafMetaFromPersistedDoor`) — the only place a Door's wire row is read for metadata. The runtime record is `{ id, token }`.

Source of truth: `parked` / `doorLeaf` / `addDoor` / `forgetLeaf` / `parkedIds` / `MAX_PARKED_SURFACES` in `lib/src/components/wall/lath-wall-store.ts`; `shouldParkOnMinimize` / `leafMetaFromPersistedDoor` in `lib/src/components/wall/lath-wall-engine.ts`; `minimizePane` in `lib/src/components/Wall.tsx`; the parked render branch in `lib/src/components/wall/LathHost.tsx`.

## The wall store and engine

The **store** is the state machine + geometry + enter hints, reached directly as `lath.store.*`; the **engine** layers presentation / vocabulary / persistence conveniences over it and **re-exports none of the store's mutators or queries**. `Wall.tsx` builds the engine lazily once per mount (a `useRef` guard, so a re-render never mints a second) and renders LathHost.

**`lath-wall-store.ts` is the sole state authority.** Its snapshot `{ tree, leafMeta, parked, zoomedId, revision }` sits behind a `useSyncExternalStore` contract: identity stable between commits, `leafMeta`/`parked` reused by identity when a commit does not touch them, `revision` bumping on *every* commit including meta and zoom writes. The reported layout geometry and the pending enter-hint map are side state, never in the snapshot, so neither notifies.

- **Every mutator applies exactly one core op**; a rejected op commits nothing, notifies nothing, and returns the failure verbatim.
- Geometry-dependent queries (`neighborOf`, `autoEdgeFor`, `resizeBoundary`, restore's fallback tier, `addLeaf`'s null-position autoEdge) read the rect + opts LathHost last reported via `setLayoutGeometry`, which **rejects a degenerate (zero-area) rect** in favor of the `!geometry` fallback (rationale).
- `LATH_LAYOUT_OPTS` (gap `PANE_GUTTER_PX` = 7; `minLeaf` 100×60) lives here as the one geometry both the store and the adapter lay out with.

**`lath-wall-engine.ts` is the Wall-facing handle**, holding only what the store does not — the animator and its `exitMs` / `markDying` / `isDying` / frame + wake signals, the vocabulary maps (Edge ↔ dor direction, arrow → direction), the meta builders (`terminalLeafMeta` / `browserLeafMeta` / `leafMetaFromPersistedDoor`), `shouldParkOnMinimize`, and the persistence conveniences `serializeLayout` / `seed` — and **no selection/focus/mode/activation state**. Two projection rules bind its readers: `listPanes()` is tree pre-order + meta, so **parked leaves are not visible and are not listed**, while `getMeta(id)` *does* resolve Doored leaves.

**All selection/focus/mode policy stays at the Wall** ([layout.md](layout.md)); three consequences bind editors here. Because nothing re-parents and nothing activates, a focus-neutral add reduces to a selection decision (`settleAddSelection`). The Cmd-Arrow swap is one `store.swapLeaves` call with **no** companion title swap — meta and registry entries follow ids. And **embed self-focus adoption rides `focusin`** (acceptance row 8), which LathHost surfaces as `onLeafFocused(id)` for the Wall to adopt like a click, there being no activation event to piggyback on. Spatial nav reaches `store.neighborOf` through the `WallNav` seam in `lib/src/components/wall/keyboard/types.ts`.

Source of truth: `lib/src/components/wall/lath-wall-store.ts`; `lib/src/components/wall/lath-wall-engine.ts`.

## The HTML adapter (LathHost)

**An adapter owns exactly three things**: mapping input into Wall coordinates, applying animator frames to its scene each tick, and hosting pane content. Layout, ops, sash geometry, and animation timelines are core and shared; LathHost is the engine's only non-headless part.

- One flat container; one stable `position: absolute` div per leaf, keyed by id, carrying `data-lath-leaf`, moved and resized by inline styles, hosting pane content as ordinary React children. The div is **never re-parented, never reordered, and never unmounted** except on a remove commit or a park eviction, and **leaf divs render in sorted-by-id DOM order, not tree order** — reordering keyed siblings moves DOM nodes, blurring the xterm inside one and reloading a moved `<iframe>`.
- Each leaf div is a 30px header slot over a filling body, plus an optional whole-leaf **overlay** slot for pointer-transparent chrome spanning header *and* body; header slot and zoom inset both derive from `PANE_HEADER_HEIGHT_PX` in `lib/src/components/design.tsx`. **All three slots resolve from `leafMeta.component` / `.tabComponent` through one registry** — body `terminal` → TerminalPanel and `browser` → BrowserPanel, tab `terminal` / `surface`, overlay `terminal` → the spoken-alarm indicator — never a surface-kind branch beside it; `componentsOverride` is the jsdom test seam for all three. **The positioned wrapper carries geometry only** — header, body, and overlay live in a memoized inner unit keyed on `{ id, meta, parked, resolved components }`, so a geometry-only frame never re-renders the content.
- Sashes render from core `sashes()` geometry as sibling divs (hit area widened to 8px, cursor per axis); a drag streams a core `resize` preview from the drag-start tree with the cumulative delta and proposes one commit on pointerup (`onCommitResize`); Escape cancels. **Geometry is reported through `store.setLayoutGeometry` from inside the measuring layout effect, never a passive effect over the rendered size** (rationale); the store's zero-area rejection is the backstop.
- Zoom retargets only the chosen leaf to the wall rect inset by `LATH_ZOOM_MARGIN` (half a pane header) and elevates it above tiled/dying panes and sashes, applying the blurred `LATH_ZOOM_SHADOW` while elevated. Unzoom keeps both until the return frame settles.
- **The binding never calls `.focus()` and emits no activation events.** Gestures surface as proposals (`onCommitResize`, `onLeafFocused`, the drag callbacks) that the Wall commits.
- The selection ring and kill overlay measure leaf elements through `resolvePaneElement`, which climbs to `[data-lath-leaf]`; `WorkspaceSelectionOverlay` re-measures on every store commit (`revision`) and every animator tick, and **same-identity re-measures snap 1:1**, so the ring tracks kills, restores, and tweens frame-accurately ([layout.md → Ring travel](layout.md#ring-travel) owns its between-panes travel, a JS tween rather than a CSS transition).

Source of truth: `lib/src/components/wall/LathHost.tsx`; the `.lath-host` rules in `lib/src/index.css`.

## Animation

**Animation is core, not adapter.** The headless **animator** turns committed layout changes into presentation frames as a pure function of time (`now` is always passed in — no DOM, timers, or `Date`), so every renderer animates identically and tests assert real interpolated values against a fake clock. [layout.md → Animations](layout.md#animations) owns the user-visible zoom / spawn / kill behaviors this implements.

- `createAnimator({ durationMs, easing? })` exposes `retarget(targets, now, enters?, { snap?, layers? })`, `markDying(id, now, { shrinkTowardBottomRight? })`, `isDying(id)`, `framesAt(now): Map<LeafId, Frame>` (`Frame = { rect, opacity, layer }`), and `settledAt(now)` — **an adapter stops ticking once settled**. **Layers are discrete, never interpolated** — `LATH_LAYER_TILED` 0 / `LATH_LAYER_DYING` 1 / `LATH_LAYER_ELEVATED` 2, a rising leaf entering the higher band before geometry moves and a lowering one staying until the motion settles; adapters map the bands to renderer z-order.
- Default motion is the house easing (`LATH_MOTION_MS` 440ms, `cubic-bezier(0.22, 1, 0.36, 1)` solved in JS by `cubicBezier`). **A caller needing a *rate* must use the returned `Easing`'s `slope(t)`**, never differences of successive samples (rationale; [layout.md → Ring travel](layout.md#ring-travel) is the cautionary case).
- **A `retarget` mid-flight starts every leaf from its current interpolated frame** — interruptible by construction, no in-progress guards. `snap: true` starts leaves already settled (sash-drag commits, container resizes: hand-placed geometry must not tween), as does a retarget whose from/to frames already match.
- **Enter hints are derived by the store's mutators, not passed in.** `addLeaf` / `restoreLeaf` / `insertLeaf` set the hint to the *opposite* of the edge they commit (`oppositeEdge`, so a pane placed right grows from its left boundary; a reattach hint therefore comes from the door token's edge), `consumeEnterHints` drains it at the next retarget, and the leaf's frames begin collapsed against that boundary at opacity 0. **Precedence**: a re-admitted parked leaf's held rect (an `EnterFrom` rect at full opacity) beats an explicit `setEnterHint`, which beats a derived hint (rationale). The only `setEnterHint` user is the auto-spawn refill (`'top-left'`, the killed last pane having shrunk toward the bottom-right).
- **Exit is two-phase.** The Wall's `lath.markDying(id, { shrinkTowardBottomRight })` freezes and fades the leaf in place — the last-pane kill shrinking toward its bottom-right corner — with its terminal DOM still mounted; a `setTimeout(lath.exitMs)` then runs `disposeSession` and commits `store.removeLeaf`, and survivors tween into the reclaimed space on the resulting retarget. The finalizer bails if the leaf is already gone (superseded by a replace) and **forgets the surface ref only after the removal** (rationale). `isDying` makes a second kill a no-op. Dying leaves get `pointer-events: none`; a dying zoomed leaf keeps its elevated inset geometry and layer while LathHost applies the animator's opacity.
- **Ownership split**: the core animator is pure and owns the dying state; the *engine* owns the animator instance, `exitMs`, and the frame/wake signals (`markDying` fades without a store commit, so it wakes the tick loop itself); the *store* owns the enter-hint map; *LathHost* drives a rAF tick while unsettled and applies `framesAt` **imperatively** to the leaf divs (left/top/width/height/opacity/z-index/box-shadow/pointer-events). **Reduced motion is the same code path**, not a branch — `durationMs` 0 under `motionIsInstant()`, which Chromatic's `animate: false` in `lib/.storybook/preview.ts` also sets. **A no-deps layout effect re-asserts the current frames after any unrelated React commit**, so a mid-tween re-render cannot snap styles back to target (rationale). **There is no CSS entrance/exit path.**

Source of truth: `createAnimator` in `lib/src/lib/lath/animator.ts`; the animator ownership in `lib/src/components/wall/lath-wall-engine.ts`; the enter-hint derivation in `lib/src/components/wall/lath-wall-store.ts`; the frame-application effects in `lib/src/components/wall/LathHost.tsx`.

## Pane props contract

**Every pane body / header component takes plain `PaneProps` and never sees the engine** — `TerminalPanel`, `BrowserPanel`, `AgentBrowserPanel`, `IframePanel`, `TerminalPaneHeader`, `SurfacePaneHeader`, plus `use-pane-chrome` / `use-surface-visibility`:

- **Read side**: `PaneProps` — `{ id, title, params, parked? }`, supplied by LathHost straight from `leafMeta`, parked leaves included; a meta commit re-renders the leaf, so params stay live either way.
- **Write side**: `PaneWriteContext` (`{ setTitle(id, t), updateParams(id, patch) }`), provided by the Wall over the store (`lath.store.setTitle` / `lath.store.updateParams`); the `wsPort`-refresh and render-swap flows route through the same seam. The value is stable per mount; the `AgentBrowserPanel` controller sink captures it once.
- **Visibility**: a mounted leaf is engine-visible unless **parked**, so `parked` is the one non-meta pane prop and absent means "not parked" — right for anything rendered outside LathHost. `useSurfaceVisibility(parked)` folds it with document visibility, so a backgrounded window and a minimized browser Surface both gate streaming while the session stays alive.
- `use-pane-chrome` registers the pane's root element in `PaneElementsContext`, for the overlays to measure, and nothing else — there is no CSS spawn-animation to trigger.

Source of truth: `lib/src/components/wall/pane-props.ts`; `PaneWriteContext` in `lib/src/components/wall/wall-context.tsx`.

## Persistence

The versioned Lath layout rides inside `PersistedSession`, and saves write only the native Lath layout. Store metadata also covers Doored leaves, so `lathLayoutFromStore` filters it to tree members and the save path materializes each Door's live metadata separately. A restart cold-loads every Surface where the user left it — **a parked document never survives a restart, only a minimize**.

**The session read boundary resolves the layout once**: `persistedLathLayout` returns the native `lathLayout` when present, else undefined. Everything downstream — the resume gate in `reconnect.ts` (leaf set must match the visible pane set), the `restoredLathLayout` prop threading, the engine's `seed` — sees only a Lath layout, and on an absent, structurally invalid, or empty one `seed` falls back to fresh panes.

Source of truth: `LeafMeta` / `LathPersistedLayout` / `lathLayoutFromStore` / `isLathPersistedLayout` in `lib/src/lib/lath/persistence.ts`; `lathLayout` / `token` in `lib/src/lib/session-types.ts`; the save in `lib/src/components/wall/use-session-persistence.ts` / `lib/src/lib/session-save.ts`; `persistedLathLayout` in `lib/src/lib/session-restore.ts`, consumed by `lib/src/lib/reconnect.ts`.

## Testing

Ordering constraint: the workspace-switching stages of the **workspaces-rollout** scope (defined in [layout.md](layout.md)) build on this engine — a workspace switch under Lath is "swap which tree renders." `onApiReady` (the old tiling-api ready callback) is gone and **must not come back**: its last consumer, the website tutorial, drives off the engine-neutral `WallEvent` stream (`paneAdded`, `selectionChange`).

Source of truth: the DOM-free suites in `lib/src/lib/lath/`, the binding suites under `lib/src/components/wall/`, and `lib/src/components/Wall.test.tsx`; live acceptance evidence is retained in the rationale.
