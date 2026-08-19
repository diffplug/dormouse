# Tiling Engine (Lath)

> See [glossary.md](glossary.md) for the Surface model, the `Window ⊃ Workspace ⊃ Pane ⊃ Surface` hierarchy, and the Pane / Door / baseboard / passthrough vocabulary used here.

> Status: implemented. Lath is Dormouse's tiling engine — the pure core under `lib/src/lib/lath/` (model, layout, ops, animator, hit-testing) and the full Wall binding with native motion and hierarchical DnD. The dockview-react dependency has been removed. [layout.md](layout.md) describes the shipped layout/interaction model; this spec owns the engine internals. Lath is an in-house headless tiling engine named for the strips hidden behind a plaster wall.

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

Zoom is not in the tree. It is presentation state (`zoomedId` in the wall store): the zoomed leaf animates into an elevated wall-sized rect inset by half the 30px pane-header height (15px), while the tree and all other rects stay unchanged beneath. The exposed perimeter and blurred app-background-colored shadow make the stacking relationship visible. This replaces `maximizeGroup` without moving or reordering the leaf DOM.

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

Source of truth: `lib/src/lib/lath/hit-test.ts` (core); the `DragController` in `lib/src/components/wall/lath-drag-controller.ts` (one gesture owner — threshold, hit-test, click-suppression — for both pane and Door drags; LathHost builds one per mount and feeds it header presses / the `externalDrag` mirror); `Door.tsx` / `Baseboard.tsx` (press reporting only); the drag callbacks in `Wall.tsx`.

Pointer events only (`pointerdown` → 5px threshold → drag; no HTML5 DnD), so drags are testable from CDP and never race React's synthetic events. The controller owns the single `DRAG_THRESHOLD`; a live drag hit-tests the store's tree read fresh each frame, so a background `dor split`/`dor kill` commit mid-drag is reflected in the next preview.

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

`remove` returns a JSON-serializable token capturing the leaf's ancestry: the nearest same-parent sibling leaf it sat beside (`siblingId`), the full leaf set and structure fingerprint of that sibling node when the sibling is itself a split subtree (`siblingLeafIds` / `siblingFingerprint`), the edge relationship (`edge`, such that neighbor-tier restore is `split(siblingId, edge, leafId)`), its normalized `weight`, its child `index`, and a structure-only `fingerprint` (kinds, dirs, leaf ids — no weights) of the parent split *post-removal*. `restore` applies a three-tier policy (the Wall drives it from `handleReattach`):

1. exact — the fingerprinted context still exists around `siblingId`: reinsert at the original index with the original weight (existing siblings shrink proportionally);
2. neighbor — the sibling still exists: split beside it on the original edge;
3. fallback — split beside a caller-supplied reference leaf (`opts.fallbackRef`) via `autoEdge` (or `'right'` when no rect is supplied). Restoring into an empty tree makes the leaf the root.

A leaf removed from a two-child split whose survivor is a single leaf always degrades to the neighbor tier: the collapse erases the fingerprinted parent, and the neighbor tier reproduces the same position (at 50/50 rather than the original weights). If the survivor is a split subtree, exact restore targets that unchanged subtree by `siblingLeafIds` / `siblingFingerprint` so `A | (B over C)` restores beside the whole `B/C` column rather than inside it. A token whose sibling is gone and whose caller supplies no `fallbackRef` fails with `ok: false` — callers own picking a live reference.

Tokens serialize with Doors (`PersistedDoor.token`) as the sole restore payload. A
parked leaf (below) still carries one: parking decides whether the DOM survives, the
token decides where the leaf lands.

## Parked leaves

Source of truth: `parked` / `doorLeaf` / `forgetLeaf` / `parkedIds` /
`MAX_PARKED_SURFACES` in `lib/src/components/wall/lath-wall-store.ts`;
`shouldParkOnMinimize` and `leafMetaFromPersistedDoor` in `lath-wall-engine.ts`; the
parked render branch in `LathHost.tsx`; `minimizePane` in `lib/src/components/Wall.tsx`.

A **parked** leaf is mounted by the adapter but absent from the split tree: its DOM
survives while it lays out nothing, paints nothing, and takes no input. It exists for
Surfaces whose state lives *in the DOM* — an `<iframe>`'s document, a screencast
canvas — where a plain remove destroys the state and the reattach is really a reload.

- **Detaching and parking are separate things.** `doorLeaf` takes a leaf out of the
  tree and *keeps its meta* — that is what every minimize does, terminal or browser,
  because the store stays the authority for a Doored Surface's live title/params.
  `{ park: true }` additionally keeps the leaf **mounted**, which is the browser-only
  part. `removeLeaf` destroys a leaf and its meta (a kill); `forgetLeaf` destroys a
  Door, unmounting it if parked.
- **One commit.** Parking is atomic: if the id were absent from both the tree and
  `parked` for even one render, React would unmount the leaf and the DOM state would
  be gone. Every op that re-admits a leaf (`addLeaf`, `restoreLeaf`, `insertLeaf`,
  `replaceLeaf`, `seed`) unparks it in that same commit, through the one shared
  `admit` helper that also seeds the enter hint — so an op added later cannot honor
  half the contract.
- **`leafMeta` covers Doors.** One map holds every leaf the Wall owns, laid out or
  Doored; `parked` is pure render state (`Map<id, Rect | null>`) naming the subset
  that keeps its DOM. Detachment is a fact about the *tree*, so metadata needs no
  second home and no Door record carries a copy that can go stale: `setTitle` /
  `updateParams` reach a Doored leaf through the same single path as a visible one,
  and reattach, `dor` param lookup, kill/session teardown, `buildDorSurfaces`,
  `dor list`, the dev-server port scan and the session save all read
  `lath.getMeta(id)`. `serializeLayout` filters `leafMeta` down to the tree's own
  leaves, because the persisted *layout* is the tree — a Door persists as its own row.
- **The store holds the last rect.** `doorLeaf({ park: true })` captures the leaf's
  current layout rect into `parked` in the same commit that removes it from the tree.
  `LathHost` unions parked ids into the same sorted leaf list and renders them there, with
  `visibility: hidden; pointer-events: none` and `data-lath-parked`. Sizing them to
  zero — or `display: none` — would report a 0×0 viewport to the guest document and
  make it reflow on the way out and back; holding the rect makes reattach pixel-identical.
  A leaf parked before the Wall reports geometry falls back to the whole wall rect.
  Keeping the rect in the store is load-bearing: `registerEl(null)` is a ref detach,
  not an unmount, and React detaches when a callback identity changes and on every
  StrictMode commit. Adapter-local pruning on detach silently lost every parked rect.
  On re-admission, `admit` seeds the animator from this held rect at full opacity for
  every admitting op and every drop target; if no rect was measured, it suppresses the
  collapsed enter hint. A still-mounted guest therefore never sees a zero-width or
  zero-height viewport during reattach.
- **Visibility is now a real signal.** A parked leaf is on screen only in the DOM
  sense, so `PaneProps.parked` carries it to the body and `useSurfaceVisibility(parked)`
  folds it together with document visibility. A minimized `ab-screencast` therefore
  stays mounted and connected but stops pulling frames.
- **Who parks**: `shouldParkOnMinimize` — browser Surfaces, not terminals. A terminal's
  state is in the PTY and the registry replays it, so parking one would only cost
  memory. Both still door through `doorLeaf`.
- **Bounded.** Each parked leaf is a live document still running scripts, timers, and
  sockets, so `MAX_PARKED_SURFACES` (8) caps the set; `doorLeaf` trims the oldest park
  in the same commit. Only the **DOM** is capped — an evicted leaf is still a Door with
  live meta, so it simply reattaches by reloading with the latest URL/session params.
  The cap is generous for the minimize workflow; it exists because the
  workspaces-rollout switch parks a whole Workspace at a time
  (`docs/specs/layout.md` → Future).
- **Hydration.** A restored session's Doors have no store entry yet, so `seed` takes
  the persisted rows and puts their meta back into `leafMeta` beside the tree's leaves
  (`leafMetaFromPersistedDoor`). That is the only place a Door's wire row is read for
  metadata; the runtime record is `{ id, token }`.

## Pane props contract

Source of truth: `lib/src/components/wall/pane-props.ts`, `PaneWriteContext` in `wall-context.tsx`, `LathHost.tsx`.

Every pane body / header component (`TerminalPanel`, `BrowserPanel`, `AgentBrowserPanel`, `IframePanel`, `TerminalPaneHeader`, `SurfacePaneHeader`, plus `use-pane-chrome` / `use-surface-visibility`) takes plain `PaneProps` — it never sees the engine:

- **Read side**: `PaneProps` — `{ id, title, params, parked? }`. LathHost supplies the first three straight from `leafMeta`, which covers parked leaves too — a meta commit re-renders the leaf, so params stay live either way.
- **Write side**: `PaneWriteContext` (`{ setTitle(id, t), updateParams(id, patch) }`), provided by the Wall and backed by the store (`lath.store.setTitle` / `lath.store.updateParams`). The `wsPort`-refresh and render-swap flows route through the same seam. The context value is stable per mount; the `AgentBrowserPanel` controller sink captures it once.
- **Visibility**: a mounted leaf is engine-visible unless it is **parked**, so `parked` is the one non-meta pane prop (LathHost supplies it; absent means "not parked", which is right for anything rendered outside LathHost). `useSurfaceVisibility(parked)` folds it together with document visibility, so both a backgrounded window and a minimized browser Surface gate streaming while the session stays alive.
- `use-pane-chrome` registers the pane's root element in `PaneElementsContext` (so the overlays can measure it) and nothing else — there is no CSS spawn-animation to trigger.

## Persistence

Source of truth: the wire format + reader/writer (`LeafMeta`, `LathPersistedLayout`, `lathLayoutFromStore`, `isLathPersistedLayout`) in `lib/src/lib/lath/persistence.ts`; `lathLayout` / `token` in `lib/src/lib/session-types.ts`; the save in `use-session-persistence.ts` / `session-save.ts`; `persistedLathLayout` in `session-restore.ts`, consumed by `reconnect.ts`.

The Lath layout serializes as `{ version: 1, tree, leafMeta }` (`LathPersistedLayout`, defined in `persistence.ts` beside the core model) — the tree is its own wire format, and `leafMeta` carries the per-leaf `{ component, tabComponent, title, params }`. It rides **inside** `PersistedSession` as the optional field `lathLayout`. Doors carry an optional restore `token`. Saves write `lathLayout` only. `leafMeta` in the STORE also covers Doored leaves, so `lathLayoutFromStore` filters it down to the tree's own leaves; each Door's live meta is materialized into its saved row instead (`use-session-persistence.ts`), so a restart cold-loads each Surface where the user left it — a parked document never survives a restart, only a minimize.

The session read boundary resolves the layout once: `persistedLathLayout` (`session-restore.ts`) returns the native `lathLayout` when present, else undefined. Everything downstream — the resume gate in `reconnect.ts` (leaf set must match the visible pane set), the `restoredLathLayout` prop threading, and the engine's `seed` — sees only a Lath layout; on an absent or unusable layout, `seed` falls back to fresh panes.

## Testing

Source of truth: `lib/src/lib/lath/{model,layout,ops,animator,hit-test,property,persistence}.test.ts` (+ shared core builders in `test-util.ts`, shared `leafMeta` fixtures in `test-fixtures.ts`); `lath-wall-store.test.ts`, `LathHost.test.tsx`, `lath-wall-engine.test.ts`, `Wall.test.tsx` under `lib/src/components/`.

- Core: DOM-free property tests over seeded random op sequences (tiling exactness, invariant preservation via `validate` after every op, the `ok: false` identity contract, `move` ≡ `remove`+insert, restore-tier degradation) plus golden trees, `neighbors`/`autoEdge`/`sashes` geometry, and per-op rejection cases. Animator: fake-clock tests asserting real interpolated rects/opacities against the exported easing — retarget mid-flight from the interpolated frame, enter-from-edge starting rects, discrete rise/hold/lower layer timing, dying freeze-and-fade + shrink geometry, snap semantics, settled detection, reduced-motion zero-duration. Hit-testing: center/edge-band/ancestor-coincidence candidates in depth order, band caps, self/no-op/duplicate filtering, external (null-dragged) drags, and previewRect equality against an explicit `move`+`layout`.
- Binding (jsdom): **node identity is preserved** across every op (the no-re-parent guarantee) and DOM order stays fixed while layout order changes; parked leaves keep the same node and children across park/restore, hold their last rect while hidden (asserted under StrictMode, where every ref detaches and re-attaches), reattach from that rect under a fixed-duration animator, sort in place, receive `parked` as a pane prop, and unmount only on `unparkLeaf` or cap eviction; cap-evicted Doors retain live metadata through late writes and re-admission; imperative frame application between commits (fake rAF + fixed-duration engine), mid-tween React re-renders not snapping styles, dying pointer-events; sash drag preview/commit/cancel and the snap-on-commit; the pane-drag gesture (threshold entry, button bail, preview overlay, wheel depth cycling, baseboard-zone minimize, Escape cancel, external door-drag mode); inset zoom expansion/return with its elevated layer lifetime; the pane props contract via `componentsOverride`; store mutator/rejection/notify semantics; the read-boundary layout resolution (`session-restore.test.ts` / `reconnect.test.ts`); engine hydration from a persisted Lath layout and from fresh pane ids; a `<Wall>` smoke (split, kill, Lath-layout save capture).
- Acceptance: all rows (1–13) of the matrix below were driven live through the standalone agent-browser harness (`pnpm dev:standalone:ab`; mechanics in `.claude/skills/debug-standalone-agent-browser/SKILL.md`) — including the exact-tier door restore from a 3-child row, sash live-resize, embed self-focus adoption, restart restores from the native layout, frame-sampled motion (kill freeze-and-fade then survivor tween, last-pane shrink-to-corner with top-left auto-spawn entry, continuous retarget under two kills 200ms apart), and the full DnD surface (pixel-exact preview-equals-commit at leaf/column/root depths with wheel cycling, center swap, drag-to-baseboard minimize, door drag-out restore at the previewed slot, selection adoption on drag start).

Acceptance matrix — each row is an end-to-end observable, independent of engine internals:

| # | Flow | Expected observable |
| --- | --- | --- |
| 1 | Type into the selected terminal | Keystrokes echo; `dor list` marks it `*` (focused) |
| 2 | `dor iframe <url>` / `dor ensure` from a touched terminal | Surface created in the background; caller keeps DOM focus (`document.activeElement` stays its xterm textarea) and selection; follow-up typing lands |
| 3 | Click between panes (body and header), both directions | Selection and focus follow the click; passthrough entered |
| 4 | `dor kill` of a background surface | Surface removed; caller's selection, focus, and typing all survive (under Lath: focus is never lost, not healed) |
| 5 | Kill the selected pane (`dor kill` self or confirm flow) | Selection adopts a survivor; typing works there |
| 6 | Minimize the last pane | Door created and selected; auto-spawn fills the Wall; **door keeps selection** through the spawn |
| 7 | Click a door | Reattach at original position when structure allows (exact tier); pane selected |
| 8 | Embedded page focuses itself (iframe surface) | Selection moves onto that pane — visible jump, same as a click; never a silent desync |
| 9 | Zoom toggle on a pane | Pane rises, expands to the 15px-inset wall rect, then shrinks and lowers on return; layout identical after |
| 10 | Restart the app (harness re-open) | Layout, doors, titles, and params restored |
| 11 | Kill with animation | Fade in place, survivors tween into the space; a second kill mid-tween retargets cleanly; reduced-motion instant |
| 12 | Drag a pane to a leaf edge, an ancestor edge, and center | Split-beside-pane, split-beside-column/row, and swap respectively; preview rect matches the committed result; dragging while a door is selected moves selection onto the dragged pane |
| 13 | Drag a pane onto the baseboard; drag a door out | Minimize with token; restore at the hit-tested position |

Row 8's counterpart guard (a background `dor` command must never yank cross-frame focus out of the host editor) is a Wall-level policy that predates Lath — its check stays in the VS Code host (the dockview focus-heal machinery it once sat beside is gone).

Ordering constraint: the workspace-switching stages of the **workspaces-rollout** scope (defined in [layout.md](layout.md)) build on this engine — a workspace switch under Lath is "swap which tree renders," with none of dockview's active-group juggling. `onApiReady` (the old tiling-api ready callback) is gone: the website tutorial, its last consumer, drives off the engine-neutral `WallEvent` stream (`paneAdded` for pane creation, `selectionChange` for kb-arrows).
