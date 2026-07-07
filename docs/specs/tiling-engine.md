# Tiling Engine (Lath)

> See [glossary.md](glossary.md) for the Surface model, the `Window ⊃ Workspace ⊃ Pane ⊃ Surface` hierarchy, and the Pane / Door / baseboard / passthrough vocabulary used here.

> Status: implemented. Lath is Dormouse's tiling engine — the pure core under `lib/src/lib/lath/` (model, layout, ops, animator, hit-testing) and the full Wall binding with native motion and hierarchical DnD. The dockview-react dependency has been removed; the only trace of it left in the codebase is the one-way legacy migration reader (`lib/src/components/wall/lath-dockview-convert.ts`) that upgrades a pre-Lath persisted `layout` blob to a Lath tree on restore. [layout.md](layout.md) describes the shipped layout/interaction model; this spec owns the engine internals. Lath is an in-house headless tiling engine named for the strips hidden behind a plaster wall.

## Why

Lath replaced dockview-react. Dormouse consumed a narrow slice of dockview — binary split tree, sash resize, drag-move, maximize, serialization; no tab stacking, no floating groups, and the mobile compositions never touched it — yet paid a broad tax for the parts of dockview's model that fought the product. What Lath removed, and why:

- **Activation conflated user intent with engine mechanics.** dockview's `onDidActivePanelChange` fired identically for clicks, drags, focus adoption, and every programmatic mutation. A whole "programmatic-activation" tag existed to reconstruct intent the engine threw away, resting on an assumption that dockview fired events synchronously. Lath has no activation events: user gestures arrive as op proposals, so selection policy lives at each mutation site with nothing to mute.
- **Rendering was coupled to activation.** A dockview pane rendered only once it was its group's active panel, forcing an add-active-then-hand-back dance behind focus-neutral surface creation. A Lath leaf renders as soon as it is mounted, so a background `dor split` is inherently focus-neutral.
- **Tree rebalance re-parented DOM.** dockview branch collapse physically moved the survivor's subtree, blurring the focused xterm and reloading any moved `<iframe>`. Lath's DOM binding never re-parents a leaf's element (below), deleting both bug classes at the root.
- **Animation was adversarial.** The dockview kill animation was a FLIP hack against the engine (rect snapshots, `animationend` plus a safety timeout, double-finalize guards, a re-resolve guard for dockview's `'invalid operation'` throw). Lath's animator is a pure function of time (below).
- **DnD was single-level.** dockview drops targeted one group's edges, with no way to drop relative to an ancestor split, and native HTML5 drag events raced React's synthetic ones. Lath's hierarchical pointer DnD (below) drops at any ancestor level.
- **Dormouse already kept a shadow model.** DOM neighbor inspection, layout snapshots with structure signatures, spatial nav doing rect math over group elements — the app re-derived the tree dockview owned but did not usefully share. Lath owns the tree, and its pure `neighbors()` / `layout()` queries replace the DOM math.

## Principles and non-goals

Lath is a **headless geometry engine**. It owns the split tree, rects, animation targets, and drag hit-testing — nothing else.

- Pure core: every operation is `(tree, args) → result`. No listeners, no event emitters, no timing assumptions. Invalid operations return the input tree unchanged with `ok: false`.
- Renderer-agnostic core: the core never imports DOM (or React, or Three.js) types — tree, `layout()`, ops, hit-testing, sash geometry, and the animator are all plain-data-in, plain-data-out. The HTML adapter (LathHost, below) is the first consumer; a Three.js adapter (serving the VR Window item in [remote-api.md](remote-api.md)'s staged remainder) is a planned second and must be able to reuse all of it unchanged.
- Lath has **no concept of selection, focus, mode, or activation**. Those stay in the Wall, where the (kind, id) selection pair and its policies already live.
- The DOM binding **never re-parents** a pane's element. Layout is geometric (absolute position + size on stable nodes), not structural.
- Non-goals: tab stacking, floating groups, popout windows (agent-browser pop-out is a separate mechanism), and the mobile compositions (MobileWall does not tile). Building the Three.js adapter itself is also out of scope — the guarantee is only that the core stays consumable by one.

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

A `'row'` split lays children left→right; `'col'` top→bottom. Trees are immutable: ops return fresh nodes along the mutated path and share structure elsewhere.

Invariants, enforced by every op and checked by the `validate(tree)` helper (returns human-readable violations; used throughout the tests):

- A split has ≥ 2 children; a split never directly contains a same-direction split (same-direction children are flattened on construction, i3-style, by the shared `normalize` constructor every op builds through). This normalization is what gives DnD its depth semantics: every ancestor boundary is a real, distinct drop level.
- Weights within a split are > 0 and normalized to sum 1.
- Leaf ids are unique. `root: null` is the empty Wall; the Wall's auto-spawn rule ("always one pane visible") stays app-level: a Wall effect watches the store and spawns into an emptied tree. There is no op for inserting into an empty tree — the Wall seeds one with `leafTree(id)`.

Nodes are addressed by **path** (`number[]` of child indexes from the root; the root is `[]`). Paths are ephemeral — valid only until the next op — and never persisted.

Zoom is not in the tree. It is presentation state (`zoomedId` in the wall store; the zoomed leaf renders full-rect on top via z-index; the tree and all other rects are unchanged beneath), replacing `maximizeGroup`.

## Layout

Source of truth: `lib/src/lib/lath/layout.ts`.

```ts
layout(tree: LathTree, rect: Rect, opts: { gap: number; minLeaf: Size }): Map<LeafId, Rect>
```

Pure. Splits divide their axis by weight; sizes round to integer pixels by cumulative rounding (child *boundaries* round, so drift never accumulates and the remainder lands left-to-right) — adjacent panes never seam or overlap. Weights are clamped at layout time against `minLeaf` via a per-split waterfill (children below their recursive minimum are pinned to it and the rest redistributes by weight); stored weights are never rewritten by layout. A split whose minimums exceed its span degrades to min-proportional allocation — still exact tiling, minimums honored only when feasible. Zero/negative rects yield zero-size rects, never a crash. Property tests assert: rects exactly tile `rect` minus gaps, no overlap, every leaf present.

Derived pure queries replace today's DOM inspection. Each takes the same `rect` + `opts` the caller renders with — feed them anything else and their geometry diverges from the screen:

- `neighbors(tree, rect, id, direction, opts) → LeafId | null` — spatial navigation without `resolvePaneGroupElement` rect scanning. Ports `findPaneInDirection` semantics: candidates strictly beyond the leaf's edge; secondary-axis overlap preferred, then nearest edge-to-edge, with deterministic tie-breaks.
- `autoEdge(tree, rect, id, opts) → Edge` — the aspect-ratio split heuristic: laid-out rect wider than tall → `'right'`, else `'bottom'`.
- `sashes(tree, rect, opts) → { splitPath, boundary, dir, rect }[]` — one entry per adjacent child pair of every split; `dir` is the parent split's axis (`'row'` → a vertical divider, col-resize) and `rect` is the gap band between the pair (zero-thickness when `gap: 0`; the adapter widens the hit area).

## Operations

Source of truth: `lib/src/lib/lath/ops.ts`.

All ops return `{ tree: LathTree; ok: boolean }` plus op-specific fields. All are pure and synchronous. On `ok: false` the returned `tree` is the **input tree object** unchanged — callers may identity-compare to detect rejected ops; on `ok: true` the tree is always a fresh object, so tree identity never signals "no visual change."

| Op | Shape | Notes |
| --- | --- | --- |
| `split` | `(tree, at: LeafId, edge, newId)` | Inserts `newId` beside `at`, extending the parent split when directions match (flatten invariant) or nesting a new one. New leaf takes half of `at`'s weight. |
| `remove` | `(tree, id)` | Removes the leaf (siblings absorb its weight proportionally), collapses single-child splits, re-flattens. Returns a `RestoreToken` (below). |
| `replace` | `(tree, oldId, newId)` | Atomic identity swap in place — the `dor iframe` replace-untouched-terminal case becomes one op with no transient add/remove states. |
| `move` | `(tree, id, target: DropTarget)` | Remove + insert as one op; weight follows the leaf (it carries its old normalized weight into the new context). `target.path` is read against the input tree, then re-found post-removal by surviving leaf set. |
| `swap` | `(tree, a, b)` | Leaf identity swap (drag-onto-center; the Cmd-Arrow swap). `a === b` is rejected. |
| `resize` | `(tree, splitPath, boundary, deltaPx, rect, opts)` | Adjusts the two weights adjacent to `boundary` (children `boundary`/`boundary + 1`), clamped so neither side drops below its recursive `minLeaf` span — with an epsilon floor keeping both weights strictly positive (a `minLeaf` of 0 may render 0px but never stores weight 0). Streamed during a sash drag: pass the *original* tree each frame with a cumulative delta; the final tree commits on pointerup. |
| `insert` | `(tree, id, target: DropTarget, weight = 0.5)` | The insert half of `move`, public for external (Door) drops: places a NEW leaf at a drop target carrying `weight` (clamped into (0,1)). Swap targets, existing ids, and empty trees are rejected. `move` is remove + re-find + `insert`. |
| `restore` | `(tree, token, opts?)` | Reinserts a removed leaf, best effort (below). |

```ts
type DropTarget =
  | { kind: 'edge'; path: number[]; edge: Edge }   // insert beside the node at path, at its parent's level
  | { kind: 'swap'; leaf: LeafId };
```

`DropTarget` is defined with the ops; its `edge`-at-ancestor-path form is what gives DnD its depth levels (Hierarchical drag and drop, below).

Because ops are cheap pure functions, speculative evaluation is free — sash live-resize and DnD previews run `layout(op(tree, …).tree, …)` per frame without committing.

## Hierarchical drag and drop

Source of truth: `lib/src/lib/lath/hit-test.ts` (core); the `DragController` in `LathHost.tsx` (one gesture owner — threshold, hit-test, click-suppression — for both pane and Door drags, built once per mount); `Door.tsx` / `Baseboard.tsx` (press reporting only); the drag callbacks in `Wall.tsx`.

Pointer events only (`pointerdown` → 5px threshold → drag; no HTML5 DnD), so drags are testable from CDP and never race React's synthetic events. LathHost owns the single `DRAG_THRESHOLD`; a live drag hit-tests the store's tree read fresh each frame, so a background `dor split`/`dor kill` commit mid-drag is reflected in the next preview.

```ts
hitTest(tree, rect, point, dragged: LeafId | null, opts): DropCandidate[]
// DropCandidate = { target: DropTarget; previewRect: Rect; depth: number }, ordered innermost → outermost
```

`hitTest` is core and renderer-agnostic: it consumes a point already in Wall coordinates (`dragged: null` is an external drag — a Door coming in — which yields no `swap` and previews via `insert`). The HTML adapter feeds it pointer positions; a Three.js adapter would feed raycast intersections. Gesture mechanics and the preview overlay are adapter concerns.

The depth model:

- The center region of a leaf yields `swap` (internal drags only, never with yourself).
- The inner edge bands of a leaf — `min(0.3 × extent, 96)` px per side; the nearest in-band edge wins a corner — yield `edge` targets **at the leaf's level**. A point in a gap attributes to the nearest leaf, so split boundaries have no dead zones.
- When the hovered leaf's edge coincides (≤ 0.5px) with an ancestor boundary, `hitTest` also yields `edge` targets **at each ancestor level** — "beside this entire column," up to the root ("new full-height/width band at the Wall's edge").
- Every candidate's `previewRect` is the exact rect the drop would commit — computed by speculatively running `move` (or `insert`) + `layout`, never a heuristic hint zone. Rejected ops, beside-itself no-ops (committed layout identical to current), and duplicates (ancestor levels the flatten invariant collapses into their child's result — common when removing the dragged leaf collapses its column) are filtered out, so every surviving depth is a genuinely different drop.
- Default resolution is the innermost candidate; the **scroll wheel** during a drag cycles outward through `depth` (wrapping; scroll up cycles backward). The candidate list resets to innermost whenever it changes identity.

Adapter gesture (LathHost): drags start on a leaf's header slot (bailing on buttons/inputs/contenteditable so header chrome keeps working, and while zoomed or during a sash drag — the two drags are mutually exclusive); the dragged leaf dims to 0.6; one `data-lath-drop-preview` overlay renders the chosen candidate's rect in the selection color; hit-testing is rAF-coalesced; Escape cancels. Grabbing a header also fires the header's press-time click path first, so a drag begins from passthrough on that pane — selection lands correctly, accepted quirk. Drops surface as proposals the Wall commits: `onDragStart(id)` (Wall moves selection onto the dragged pane — covering the drag-while-door-selected case), `onProposeMove(id, target)` (→ `moveLeaf`, then select), `onProposeMinimize(id)` when released below the container (→ the standard `minimizePane`, token and all; the Wall gates it on `showBaseboard`, so it no-ops when the baseboard is hidden — there is nowhere to minimize into). Committed moves tween via the animator.

Door drag-out: a `Door` press reports its start point (`onDoorDragStart(item, press)`), and the Wall puts LathHost into external-drag mode immediately (`externalDrag={ id, startX, startY }`). LathHost applies the same threshold as an internal drag: below it the press is a plain click (reattach); once crossed it runs the same hit-test/preview/wheel machinery with `dragged: null`, the chip staying put in the baseboard. A drop on a candidate removes the Door and `insertLeaf`s the surface at the hit-tested target (the token is not consulted — the user chose the position) with an enter hint from the target edge; a drop on nothing (or Escape, a sub-threshold release, or dropping back onto the baseboard) leaves the Door in place. One gesture system — one threshold, one click-suppressor — spans panes and Doors.

## Restore tokens (Doors)

Source of truth: `RestoreToken` and `restore` in `lib/src/lib/lath/ops.ts`.

`remove` returns a JSON-serializable token capturing the leaf's ancestry: the nearest same-parent sibling leaf it sat beside (`siblingId`), the edge relationship (`edge`, such that neighbor-tier restore is `split(siblingId, edge, leafId)`), its normalized `weight`, its child `index`, and a structure-only `fingerprint` (kinds, dirs, leaf ids — no weights) of the parent split *post-removal*. `restore` applies a three-tier policy (the Wall drives it from `handleReattach`):

1. exact — the fingerprinted context still exists around `siblingId`: reinsert at the original index with the original weight (existing siblings shrink proportionally);
2. neighbor — the sibling still exists: split beside it on the original edge;
3. fallback — split beside a caller-supplied reference leaf (`opts.fallbackRef`) via `autoEdge` (or `'right'` when no rect is supplied). Restoring into an empty tree makes the leaf the root.

A leaf removed from a two-child split always degrades to the neighbor tier: the collapse erases the fingerprinted parent, and the neighbor tier reproduces the same position (at 50/50 rather than the original weights). A token whose sibling is gone and whose caller supplies no `fallbackRef` fails with `ok: false` — callers own picking a live reference.

Tokens serialize with Doors (`PersistedDoor.token`) as the sole restore payload; a Door persisted before Lath (no token) restores at the neighbor tier via a token synthesized from its legacy `{neighborId, direction}` fields (`legacyTokenFromDoor` in `lib/src/components/wall/lath-wall-engine.ts`; an absent `neighborId` degrades to the fallback tier, an absent `direction` defaults to `'right'`).

## The wall store and engine

Source of truth: `lib/src/components/wall/lath-wall-store.ts`; `lib/src/components/wall/lath-wall-engine.ts`. `Wall.tsx` constructs the engine lazily once per mount and renders LathHost. The split is crisp: the **store** is the state machine + geometry + enter hints, and every state op / geometry query reaches it directly as `lath.store.*`; the **engine** layers presentation / vocabulary / persistence conveniences over it and re-exports none of the store's mutators or queries.

- **`lath-wall-store.ts`** — the headless store (the sole state authority): `{ tree, leafMeta, zoomedId, revision }` behind a `useSyncExternalStore` contract (snapshot identity is stable between commits; `revision` bumps on every commit), plus the reported layout geometry and the pending enter-hint map (both side state, never in the snapshot). `leafMeta` maps leaf id → `{ component, tabComponent, title, params }`, serialized inside the persisted Lath layout. Every mutator applies exactly one core op; a rejected op commits nothing and never notifies. Geometry-dependent queries (`neighborOf`, `autoEdgeFor`, `resizeBoundary`, restore's fallback tier, `addLeaf`'s null-position autoEdge) use the rect + opts LathHost last reported via `setLayoutGeometry`.
- **`lath-wall-engine.ts`** — the Wall-facing handle over the store, holding only what the store does not: the animator (+ `exitMs` / `markDying` / `isDying` / frame + wake signals; see Animation), the read projections `listPanes()` (tree pre-order + meta — read by `buildDorSurfaces`, persistence, and dev-server correlation) and `getMeta(id)`, the vocabulary maps (Edge ↔ dor-direction, Door-direction → Edge via `edgeForDoorDirection`, arrow → direction), the meta builders `terminalLeafMeta` / `browserLeafMeta` / `leafMetaFromDoor` (which canonicalizes legacy `iframe`/`agent-browser` component aliases to `browser`), `legacyTokenFromDoor`, and the persistence conveniences `serializeLayout` + three-way hydration `seed` (persisted Lath layout → migrated legacy dockview blob → fresh panes). It holds no selection/focus/mode/activation state.
- The Wall keeps all selection/focus/mode policy: `dor split`-style adds are inherently focus-neutral (nothing re-parents, nothing activates), so focus-neutral creation reduces to a selection decision (`settleAddSelection`); the Cmd-Arrow swap is one `store.swapLeaves` call with **no** companion title swap (meta and registry entries follow ids); kills fade then remove (the two-phase animator kill, below), with a selection-adoption tail; keyboard spatial nav rides `store.neighborOf` through the `WallNav` seam in `lib/src/components/wall/keyboard/types.ts`.
- Embed self-focus adoption (acceptance row 8) has no activation event to piggyback on: LathHost surfaces `focusin` inside a leaf as `onLeafFocused(id)`, and the Wall adopts it with the same passthrough/command policy a click would.

## Adapters; the HTML adapter (LathHost)

Source of truth: `lib/src/components/wall/LathHost.tsx` (+ the `.lath-host` rules in `lib/src/index.css`).

An adapter owns exactly three things: mapping input into Wall coordinates (pointer position in HTML; a controller/gaze raycast against the wall plane in a Three.js adapter), applying animator frames to its scene each tick, and hosting pane content. Layout, ops, sash geometry, and animation timelines are core and shared.

LathHost, the HTML adapter (a thin React component, the only non-headless part of the engine):

- One flat container; one stable `position: absolute` div per leaf, keyed by id and carrying `data-lath-leaf`. Pane content renders as ordinary React children into that div. The div moves and resizes via inline styles; it is **never re-parented, never reordered, and never unmounted** except on remove-commit — leaf divs render in *sorted-by-id* DOM order, not tree order, because React reordering keyed siblings moves DOM nodes and a moved `<iframe>` reloads. This deletes the re-parent blur class of bugs and the iframe-reload constraint at the root rather than healing them.
- Each leaf div is a 30px header slot over a filling body; components resolve from `leafMeta.component` / `.tabComponent` with the alias table (legacy `iframe`/`agent-browser` → BrowserPanel). A `componentsOverride` prop is the jsdom test seam (never mounts real xterm). The positioned wrapper carries geometry only; its header + body live in a memoized inner content unit keyed on `{ id, meta, resolved components }`, so a geometry-only frame (a sash-drag preview, a resize commit) re-renders the wrapper but never the header or body.
- Sashes render from core `sashes()` geometry as sibling divs (hit area widened to 8px, cursor per axis); a drag streams a core `resize` preview from the drag-start tree with the cumulative delta and proposes a single commit on pointerup (`onCommitResize`); Escape cancels. Geometry is reported back via `store.setLayoutGeometry` so store queries match the screen (`LATH_LAYOUT_OPTS`: gap 6; minLeaf 100×60).
- The zoomed leaf renders full-rect above the others via z-index; sashes sit between (they disappear under the zoomed leaf).
- The binding never calls `.focus()` and emits no activation events. Gestures surface as proposals (`onCommitResize`, `onLeafFocused`) that the Wall commits — selection/focus policy stays at the Wall call sites.
- The selection ring and kill overlay measure leaf elements through `resolvePaneElement`, which climbs to `[data-lath-leaf]`; `WorkspaceSelectionOverlay` re-measures on every store commit (`revision` via `useSyncExternalStore`), and additionally on every animator tick (the engine's frame signal), dropping its 150ms CSS transition while frames stream so the ring tracks kills, restores, and tweens frame-accurately.

## Animation

Source of truth: `lib/src/lib/lath/animator.ts` (core); the engine's animator ownership in `lath-wall-engine.ts`; the enter-hint derivation in `lath-wall-store.ts`; the frame-application effects in `LathHost.tsx`.

Animation is core, not adapter: the headless **animator** turns committed layout changes into presentation frames as a pure function of time (`now` is always passed in — no DOM, timers, or Date), so every renderer animates identically and tests assert real interpolated values against a fake clock.

- `createAnimator({ durationMs, easing? })` exposes `retarget(targets, now, enters?, { snap? })`, `markDying(id, now, { shrinkTowardBottomRight? })`, `isDying(id)`, `framesAt(now): Map<LeafId, Frame>` (`Frame = { rect, opacity, layer }`; layer 0 tiled, 1 dying), and `settledAt(now)` (adapters stop ticking when settled).
- Default motion is the house easing (`LATH_MOTION_MS` 440ms, `cubic-bezier(0.22, 1, 0.36, 1)` solved in JS by the exported `cubicBezier`). A `retarget` mid-flight starts every leaf from its current interpolated frame — interruptible by construction; no `killInProgressRef`-style guards. `snap: true` starts leaves already settled (sash-drag commits and container resizes — hand-placed geometry must not tween).
- **Enter**: the store's mutators derive the hint internally — `addLeaf` / `restoreLeaf` / `insertLeaf` set it from the edge they actually commit (the *opposite* of the placement edge, via `oppositeEdge` in the core model, so a pane placed to the right grows from its left boundary), drained at the next retarget through `consumeEnterHints`; the leaf's frames begin collapsed against that boundary at opacity 0. This covers `addLeaf`'s null-position `autoEdge` fallback (those adds animate too) and derives reattach hints from the door token's edge. An explicit `setEnterHint` is a policy override that wins over any derived hint — the only current user is the auto-spawn refill (`'top-left'`, since the killed last pane shrank toward the bottom-right).
- **Exit**: removal is two-phase. The Wall calls `lath.markDying(id, { shrinkTowardBottomRight })` (freeze-and-fade in place; the last-pane kill shrinks toward its bottom-right corner) with the session disposed up front so the content freezes under the fade, then commits `removeLeaf` in a `setTimeout(lath.exitMs)` — survivors tween into the reclaimed space on the resulting retarget. `isDying` makes a second kill of the same pane a no-op; selection adoption stays a live re-read at removal time. Dying leaves get `pointer-events: none`.
- **Ownership split**: the core animator is pure and owns the dying state (`markDying` / `isDying`); the *engine* owns the animator instance (`durationMs` 0 under `prefersReducedMotion()` — reduced motion runs the same code), `exitMs`, and the frame/wake signals; the *store* owns the enter-hint map (LathHost drains it via `store.consumeEnterHints` at each retarget; the Wall's auto-spawn policy override calls `store.setEnterHint`); *LathHost* merely drives a rAF tick while unsettled and applies `framesAt` **imperatively** to the registered leaf divs (left/top/width/height/opacity/z-index/pointer-events). React keeps rendering target geometry — the memoized `LathLeaf`s do not re-render during a tween, and a no-deps layout effect re-asserts the current frames after any unrelated React commit so a mid-tween re-render can't snap styles to target. There is no CSS entrance/exit path: entry and exit are entirely animator-driven.
- Known minor gap: killing a *zoomed* pane skips the fade (frames are not applied to the zoomed leaf) — instant removal, accepted for now.

## Pane props contract

Source of truth: `lib/src/components/wall/pane-props.ts`, `PaneWriteContext` in `wall-context.tsx`, `LathHost.tsx`.

Every pane body / header component (`TerminalPanel`, `BrowserPanel`, `AgentBrowserPanel`, `IframePanel`, `TerminalPaneHeader`, `SurfacePaneHeader`, plus `use-pane-chrome` / `use-surface-visibility`) takes plain `PaneProps` — it never sees the engine:

- **Read side**: `PaneProps` — `{ id, title, params }`. LathHost supplies them straight from `leafMeta` — a meta commit re-renders the leaf, so params stay live.
- **Write side**: `PaneWriteContext` (`{ setTitle(id, t), updateParams(id, patch) }`), provided by the Wall and backed by the store (`lath.store.setTitle` / `lath.store.updateParams`). The `wsPort`-refresh and render-swap flows route through the same seam. The context value is stable per mount; the `AgentBrowserPanel` controller sink captures it once.
- **Visibility**: under Lath a mounted leaf is always engine-visible, so there is no per-pane visibility prop; `useSurfaceVisibility()` reduces to document visibility (a backgrounded window still gates streaming so a hidden pane stops consuming resources).
- `use-pane-chrome` registers the pane's root element in `PaneElementsContext` (so the overlays can measure it) and nothing else — there is no CSS spawn-animation to trigger.

## Persistence and migration

Source of truth: the wire format + reader/writer (`LathPersistedLayout`, `lathLayoutFromStore`, `isLathPersistedLayout`) in `lib/src/components/wall/lath-persistence.ts`; `lathLayout` / `token` in `lib/src/lib/session-types.ts`; the save in `use-session-persistence.ts` / `session-save.ts`; the legacy upgrade reader `lib/src/components/wall/lath-dockview-convert.ts`; threading in `session-restore.ts` / `reconnect.ts`.

The Lath layout serializes as `{ version: 1, tree, leafMeta }` (`LathPersistedLayout`, defined in `lath-persistence.ts`) — the tree is its own wire format, and `leafMeta` carries the per-leaf `{ component, tabComponent, title, params }`. It rides **inside** `PersistedSession` as the optional field `lathLayout` (no v3 version bump). Doors carry an optional restore `token`. Saves write `lathLayout` only; the pre-Lath dockview `layout` key is no longer emitted.

`PersistedSession.layout` is retained as an **optional legacy field** — read-only, only present in blobs written before Lath — and `PersistedDoor`'s `{neighborId, direction, remainingPaneIds, layoutAtMinimize, layoutAtMinimizeSignature}` are likewise optional legacy-read-only fields; the v3 guard accepts a blob carrying either `layout` or `lathLayout`. Per the persisted-session migration conventions in [transport.md](transport.md), old blobs flow through unchanged.

Restore prefers `lathLayout`; when only a legacy dockview `layout` is present it migrates one-way via `dockviewLayoutToLath` (grid branches → splits, sizes → normalized weights, panels → leaves + leafMeta, multi-view groups degrading to even splits; `lath-dockview-convert.ts` models the serialized dockview shape with local structural types, no dockview dependency), else fresh panes. The resume path gates `lathLayout` on its own leaf-set match and, in parallel, the legacy `layout` on its panel set (`reconnect.ts`). A Door persisted before Lath (no token) degrades to neighbor-tier restore. This one-way reader is the only remaining trace of dockview in the codebase; it stays for the deprecation window so existing users' saved layouts survive the upgrade.

Reserved: the legacy `layout` / `PersistedDoor` fields stay defined and read on restore so a pre-Lath snapshot still opens; deleting them would break the upgrade path for users on an old save.

## Testing

Source of truth: `lib/src/lib/lath/{model,layout,ops,animator,hit-test,property}.test.ts` (+ shared core builders in `test-util.ts`); `lath-wall-store.test.ts`, `lath-dockview-convert.test.ts`, `lath-persistence.test.ts`, `LathHost.test.tsx`, `lath-wall-engine.test.ts`, `Wall.test.tsx` under `lib/src/components/` (+ the shared `leafMeta` / dockview fixtures in `lath-test-fixtures.ts`).

- Core: DOM-free property tests over seeded random op sequences (tiling exactness, invariant preservation via `validate` after every op, the `ok: false` identity contract, `move` ≡ `remove`+insert, restore-tier degradation) plus golden trees, `neighbors`/`autoEdge`/`sashes` geometry, and per-op rejection cases. Animator: fake-clock tests asserting real interpolated rects/opacities against the exported easing — retarget mid-flight from the interpolated frame, enter-from-edge starting rects, dying freeze-and-fade + shrink geometry, snap semantics, settled detection, reduced-motion zero-duration. Hit-testing: center/edge-band/ancestor-coincidence candidates in depth order, band caps, self/no-op/duplicate filtering, external (null-dragged) drags, and previewRect equality against an explicit `move`+`layout`.
- Binding (jsdom): **node identity is preserved** across every op (the no-re-parent guarantee) and DOM order stays fixed while layout order changes; imperative frame application between commits (fake rAF + fixed-duration engine), mid-tween React re-renders not snapping styles, dying pointer-events; sash drag preview/commit/cancel and the snap-on-commit; the pane-drag gesture (threshold entry, button bail, preview overlay, wheel depth cycling, baseboard-zone minimize, Escape cancel, external door-drag mode); zoom; the pane props contract via `componentsOverride`; store mutator/rejection/notify semantics; the legacy-blob migration reader against a hand-written serialized-dockview fixture; engine hydration from each of the three seed sources; a `<Wall>` smoke (split, kill, Lath-layout save capture).
- Acceptance: all rows (1–13) of the matrix below were driven live through the standalone agent-browser harness (`pnpm dev:standalone:ab`; mechanics in `.claude/skills/debug-standalone-agent-browser/SKILL.md`) — including the exact-tier door restore from a 3-child row, sash live-resize, embed self-focus adoption, restart restores from both the native layout and a hand-built pre-Lath legacy blob, frame-sampled motion (kill freeze-and-fade then survivor tween, last-pane shrink-to-corner with top-left auto-spawn entry, continuous retarget under two kills 200ms apart), and the full DnD surface (pixel-exact preview-equals-commit at leaf/column/root depths with wheel cycling, center swap, drag-to-baseboard minimize, door drag-out restore at the previewed slot, selection adoption on drag start).

Acceptance matrix — each row is an end-to-end observable, independent of engine internals:

| # | Flow | Expected observable |
| --- | --- | --- |
| 1 | Type into the selected terminal | Keystrokes echo; `dor list-panes` marks it `[focused]` |
| 2 | `dor iframe <url>` / `dor ensure` from a touched terminal | Surface created in the background; caller keeps DOM focus (`document.activeElement` stays its xterm textarea) and selection; follow-up typing lands |
| 3 | Click between panes (body and header), both directions | Selection and focus follow the click; passthrough entered |
| 4 | `dor kill` of a background surface | Surface removed; caller's selection, focus, and typing all survive (under Lath: focus is never lost, not healed) |
| 5 | Kill the selected pane (`dor kill` self or confirm flow) | Selection adopts a survivor; typing works there |
| 6 | Minimize the last pane | Door created and selected; auto-spawn fills the Wall; **door keeps selection** through the spawn |
| 7 | Click a door | Reattach at original position when structure allows (exact tier); pane selected |
| 8 | Embedded page focuses itself (iframe surface) | Selection moves onto that pane — visible jump, same as a click; never a silent desync |
| 9 | Zoom toggle on a pane | Full-rect render and back; layout identical after |
| 10 | Restart the app (harness re-open) | Layout, doors, titles, and params restored — including from a pre-Lath legacy blob |
| 11 | Kill with animation | Fade in place, survivors tween into the space; a second kill mid-tween retargets cleanly; reduced-motion instant |
| 12 | Drag a pane to a leaf edge, an ancestor edge, and center | Split-beside-pane, split-beside-column/row, and swap respectively; preview rect matches the committed result; dragging while a door is selected moves selection onto the dragged pane |
| 13 | Drag a pane onto the baseboard; drag a door out | Minimize with token; restore at the hit-tested position |

Row 8's counterpart guard (a background `dor` command must never yank cross-frame focus out of the host editor) is a Wall-level policy that predates Lath — its check stays in the VS Code host (the dockview focus-heal machinery it once sat beside is gone).

Ordering constraint: the workspace-switching stages of the **workspaces-rollout** scope (defined in [layout.md](layout.md)) build on this engine — a workspace switch under Lath is "swap which tree renders," with none of dockview's active-group juggling. `onApiReady` (the old tiling-api ready callback) is gone: the website tutorial, its last consumer, drives off the engine-neutral `WallEvent` stream (`paneAdded` for pane creation, `selectionChange` for kb-arrows).
