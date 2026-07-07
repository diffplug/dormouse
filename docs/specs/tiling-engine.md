# Tiling Engine (Lath)

> See [glossary.md](glossary.md) for the Surface model, the `Window ⊃ Workspace ⊃ Pane ⊃ Surface` hierarchy, and the Pane / Door / baseboard / passthrough vocabulary used here.

> Status: stages 1–2 of the lath-rollout scope are implemented — the pure core under `lib/src/lib/lath/` and the full Wall binding behind the `dormouse.flags.lath` dev flag (acceptance rows 1–10 verified live). **Flag off — the default — Dormouse still ships dockview-react**, and [layout.md](layout.md) remains the source of truth for that path's behavior. Everything under `## Future` here — animation, DnD, and the dockview deletion sweep — is the remaining dream design for **Lath**, an in-house headless tiling engine named for the strips hidden behind a plaster wall, written ahead of the code per the spec lifecycle in AGENTS.md.

## Why

Dormouse consumes a narrow slice of dockview — binary split tree, sash resize, drag-move, maximize, serialization; no tab stacking, no floating groups, and the mobile compositions never touch it — yet pays a broad tax for the parts of dockview's model that fight the product:

- **Activation conflates user intent with engine mechanics.** `onDidActivePanelChange` fires identically for clicks, drags, focus adoption, and every programmatic mutation. The entire `lib/src/lib/programmatic-activation.ts` mechanism exists to reconstruct intent the engine throws away, and rests on a documented assumption that dockview fires events synchronously.
- **Rendering is coupled to activation.** A pane renders only once it is its group's active panel, which forced the add-active-then-hand-back dance behind focus-neutral surface creation (layout.md corner case #12).
- **Tree rebalance re-parents DOM.** Branch collapse physically moves the survivor's subtree, blurring the focused xterm (the `reassertPaneFocus` heals) and reloading any moved `<iframe>` (the `renderer: 'always'` constraint in [dor-browser.md](dor-browser.md)).
- **Animation is adversarial.** `lib/src/lib/kill-animation.ts` is a FLIP hack against the engine: rect snapshots, `animationend` plus a safety timeout, double-finalize guards, and a re-resolve guard for dockview's `'invalid operation'` throw.
- **DnD is single-level.** Drops target one group's edges; there is no way to drop relative to an ancestor split, and native HTML5 drag events race React's synthetic ones.
- **Dormouse already keeps a shadow model.** `findReattachNeighbor` DOM inspection, `layoutAtMinimize` snapshots with structure signatures, spatial nav doing rect math over group elements — the app keeps re-deriving the tree dockview owns but does not usefully share.

The programmatic-activation refactor was the down payment: selection policy already lives at each mutation site, so when Lath removes activation events entirely, the tag that mutes them retires with nothing else to move.

## Principles and non-goals

Lath is a **headless geometry engine**. It owns the split tree, rects, animation targets, and drag hit-testing — nothing else.

- Pure core: every operation is `(tree, args) → result`. No listeners, no event emitters, no timing assumptions. Invalid operations return the input tree unchanged with `ok: false`.
- Renderer-agnostic core: the core never imports DOM (or React, or Three.js) types — tree, `layout()`, ops, hit-testing, sash geometry, and the animator are all plain-data-in, plain-data-out. The HTML adapter (LathHost, below) is the first consumer; a Three.js adapter (serving the VR Window item in [remote-api.md](remote-api.md)'s staged remainder) is a planned second and must be able to reuse all of it unchanged.
- Lath has **no concept of selection, focus, mode, or activation**. Those stay in the Wall, where the (kind, id) selection pair and its policies already live.
- The DOM binding **never re-parents** a pane's element. Layout is geometric (absolute position + size on stable nodes), not structural.
- Non-goals: tab stacking, floating groups, popout windows (agent-browser pop-out is a separate mechanism), and the mobile compositions (MobileWall does not tile). The Three.js adapter itself is also a non-goal of lath-rollout — the scope only guarantees the core stays consumable by one.

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
- `autoEdge(tree, rect, id, opts) → Edge` — the aspect-ratio split heuristic, replacing `pickSplitDirection`: laid-out rect wider than tall → `'right'`, else `'bottom'`.
- `sashes(tree, rect, opts) → { splitPath, boundary, rect }[]` — one entry per adjacent child pair of every split; `rect` is the gap band between them (zero-thickness when `gap: 0`; the adapter widens the hit area).

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
| `restore` | `(tree, token, opts?)` | Reinserts a removed leaf, best effort (below). |

```ts
type DropTarget =
  | { kind: 'edge'; path: number[]; edge: Edge }   // insert beside the node at path, at its parent's level
  | { kind: 'swap'; leaf: LeafId };
```

`DropTarget` is defined with the ops (its `edge`-at-ancestor-path form is what gives DnD its depth levels); the `hitTest` that produces candidates is unbuilt — see Hierarchical drag and drop under `## Future`.

Because ops are cheap pure functions, speculative evaluation is free — sash live-resize (and, in stage 4, DnD previews) runs `layout(op(tree, …).tree, …)` per frame without committing.

## Restore tokens (Doors)

Source of truth: `RestoreToken` and `restore` in `lib/src/lib/lath/ops.ts`.

`remove` returns a JSON-serializable token capturing the leaf's ancestry: the nearest same-parent sibling leaf it sat beside (`siblingId`), the edge relationship (`edge`, such that neighbor-tier restore is `split(siblingId, edge, leafId)`), its normalized `weight`, its child `index`, and a structure-only `fingerprint` (kinds, dirs, leaf ids — no weights) of the parent split *post-removal*. `restore` applies a three-tier policy mirroring the dockview path's reattach ladder in `handleReattach`:

1. exact — the fingerprinted context still exists around `siblingId`: reinsert at the original index with the original weight (existing siblings shrink proportionally);
2. neighbor — the sibling still exists: split beside it on the original edge;
3. fallback — split beside a caller-supplied reference leaf (`opts.fallbackRef`) via `autoEdge` (or `'right'` when no rect is supplied). Restoring into an empty tree makes the leaf the root.

A leaf removed from a two-child split always degrades to the neighbor tier: the collapse erases the fingerprinted parent, and the neighbor tier reproduces the same position (at 50/50 rather than the original weights). A token whose sibling is gone and whose caller supplies no `fallbackRef` fails with `ok: false` — callers own picking a live reference.

Under the flag, tokens serialize with Doors (`PersistedDoor.token`) and replace `layoutAtMinimize` + `getLayoutStructureSignature` + `findReattachNeighbor` on that path; a pre-Lath Door (no token) restores at the neighbor tier via a token synthesized from its `{neighborId, direction}` (`legacyTokenFromDoor` in `lib/src/components/wall/lath-wall-engine.ts`). The dockview path still uses the legacy ladder; its machinery is deleted at stage 5.

## The flag and the wall store

Source of truth: `isLathEnabled` in `lib/src/lib/feature-flags.ts`; `lib/src/components/wall/lath-wall-store.ts`; `lib/src/components/wall/lath-wall-engine.ts`.

The dev flag is `dormouse.flags.lath` in localStorage, read once per Wall mount (toggling requires a reload — the same contract as `dormouse.flags.abDebugLogs`). Flag off: `Wall.tsx`'s engine handle is null and every mutation site takes its untouched dockview branch. Flag on: DockviewReact never mounts (`apiRef` stays null), the Wall renders LathHost, and each mutation site routes through the engine.

- **`lath-wall-store.ts`** — the headless store: `{ tree, leafMeta, zoomedId, revision }` behind a `useSyncExternalStore` contract (snapshot identity is stable between commits; `revision` bumps on every commit). `leafMeta` maps leaf id → `{ component, tabComponent, title, params }` — the state that rides inside dockview's serialized panel blobs on the other path. Every mutator applies exactly one core op; a rejected op commits nothing and never notifies. Geometry-dependent queries (`neighborOf`, `autoEdgeFor`, restore's fallback tier, `addLeaf`'s null-position autoEdge) use the rect + opts LathHost last reported via `setLayoutGeometry`.
- **`lath-wall-engine.ts`** — the Wall-facing handle wrapping the store: `listPanes()` (tree pre-order + meta — the engine-neutral projection `buildDorSurfaces`, persistence, and dev-server correlation read), the Edge ↔ dor-direction ↔ DoorDirection maps, `terminalLeafMeta`/`browserLeafMeta`, `legacyTokenFromDoor`, `serializeLayout`, and three-way hydration `seed` (persisted Lath layout → migrated dockview blob → fresh panes).
- The Wall keeps all selection/focus/mode policy: `dor split`-style adds are inherently focus-neutral under Lath (nothing re-parents, nothing activates), so the focus-neutral machinery reduces to a selection decision (`settleAddSelection`); the Cmd-Arrow swap is one `swapLeaves` call with **no** `swapTerminals`/`swapPanelTitles` companion (meta and registry entries follow ids); kills are instant (`removeLeaf` + the same selection-adoption tail — animation arrives in stage 3); keyboard spatial nav rides `neighborOf` through the engine-neutral `WallNav` seam in `lib/src/components/wall/keyboard/types.ts`.
- Embed self-focus adoption (acceptance row 8) has no activation event to piggyback on: LathHost surfaces `focusin` inside a leaf as `onLeafFocused(id)`, and the Wall adopts it with the same policy as the dockview activation listener.

## Adapters; the HTML adapter (LathHost)

Source of truth: `lib/src/components/wall/LathHost.tsx` (+ the `.lath-host` rules in `lib/src/index.css`).

An adapter owns exactly three things: mapping input into Wall coordinates (pointer position in HTML; a controller/gaze raycast against the wall plane in a Three.js adapter), applying frames to its scene, and hosting pane content. Layout, ops, sash geometry — and, from stage 3, animation timelines — are core and shared.

LathHost, the HTML adapter (a thin React component, the only non-headless part of lath-rollout):

- One flat container; one stable `position: absolute` div per leaf, keyed by id and carrying `data-lath-leaf`. Pane content renders as ordinary React children into that div. The div moves and resizes via inline styles; it is **never re-parented, never reordered, and never unmounted** except on remove-commit — leaf divs render in *sorted-by-id* DOM order, not tree order, because React reordering keyed siblings moves DOM nodes and a moved `<iframe>` reloads. This deletes the re-parent blur class of bugs and the iframe-reload constraint at the root rather than healing them.
- Each leaf div is a header slot (30px, matching `--dv-tabs-and-actions-container-height`) over a filling body; components resolve from `leafMeta.component` / `.tabComponent` with the same alias table as the dockview path (legacy `iframe`/`agent-browser` → BrowserPanel). A `componentsOverride` prop is the jsdom test seam (never mounts real xterm).
- Sashes render from core `sashes()` geometry as sibling divs (hit area widened to 8px, cursor per axis); a drag streams a core `resize` preview from the drag-start tree with the cumulative delta and proposes a single commit on pointerup (`onCommitResize`); Escape cancels. Geometry is reported back via `store.setLayoutGeometry` so store queries match the screen (`LATH_LAYOUT_OPTS`: gap 6 = the dockview theme's gap; minLeaf 100×60).
- The zoomed leaf renders full-rect above the others via z-index; sashes sit between (they disappear under the zoomed leaf).
- The binding never calls `.focus()` and emits no activation events. Gestures surface as proposals (`onCommitResize`, `onLeafFocused`) that the Wall commits — selection/focus policy stays at the same Wall call sites where it lives today.
- The selection ring and kill overlay measure leaf elements through `resolvePaneElement`, which climbs to `[data-lath-leaf]` exactly as it climbs to dockview groupviews; `WorkspaceSelectionOverlay` re-measures on every store commit (`revision` via `useSyncExternalStore`) instead of `api.onDidLayoutChange`.

## Pane props contract

Source of truth: `lib/src/components/wall/pane-props.ts`, `PaneWriteContext` in `wall-context.tsx`, `dockview-panel-adapters.tsx`.

Every pane body / header component (`TerminalPanel`, `BrowserPanel`, `AgentBrowserPanel`, `IframePanel`, `TerminalPaneHeader`, `SurfacePaneHeader`, plus `use-pane-chrome` / `use-surface-visibility`) is engine-agnostic:

- **Read side**: plain `PaneProps` — `{ id, title, params, panelVisible, getAnimEl }`. Under dockview, the four thin adapters in `dockview-panel-adapters.tsx` (the only surviving pane-side consumers of `IDockviewPanelProps` / `IDockviewPanelHeaderProps`) build them from the panel object, subscribing to title/visibility events; under Lath, LathHost supplies them straight from `leafMeta` — a meta commit re-renders the leaf, so params stay live.
- **Write side**: `PaneWriteContext` (`{ setTitle(id, t), updateParams(id, patch) }`), provided by the Wall — dockview-backed (`getPanel(id).api.*`) or store-backed (`lath.setTitle` / `lath.updateParams`). The `wsPort`-refresh and render-swap flows route through the same seam. The context value is stable per mount; the `AgentBrowserPanel` controller sink captures it once.
- **Visibility**: `panelVisible` is the engine half only (dockview: active tab in its group; Lath: a mounted leaf is always visible — `true`); `useSurfaceVisibility(panelVisible)` ANDs in document visibility.
- **`getAnimEl`** designates the element for the spawn-animation class (dockview: the group element; Lath: the leaf div).

## Persistence and migration

Source of truth: `lib/src/components/wall/lath-dockview-convert.ts`; `lathLayout` / `token` in `lib/src/lib/session-types.ts`; the dual-write in `use-session-persistence.ts`; threading in `session-restore.ts` / `reconnect.ts`.

The Lath layout serializes as `{ version: 1, tree, leafMeta }` (`LathPersistedLayout`) — the tree is its own wire format, and `leafMeta` carries the per-leaf `{ component, tabComponent, title, params }`. As built, it rides **inside** `PersistedSession` as the additive optional field `lathLayout` (no v3 version bump; absent reads as pre-Lath) rather than replacing the persisted shape; Doors gain the additive optional `token`. Per the persisted-session migration conventions in [transport.md](transport.md), old blobs flow through unchanged.

While the flag exists (stages 2–4), saves **dual-write both formats regardless of flag state**, so flipping the flag either direction never loses a layout:

- Flag on: `layout` = `lathToDockviewLayout(tree)` (a synthesized `SerializedDockview` — branch-rooted grid, depth-alternating orientation, weights scaled to sizes, `renderer: 'always'` on browser panes), `lathLayout` = the native form.
- Flag off: `layout` = `api.toJSON()` as always, `lathLayout` = `dockviewLayoutToLath(api.toJSON())` (omitted on conversion failure).

Restore prefers `lathLayout`, falls back to migrating the dockview blob (grid branches → splits, sizes → normalized weights, panels → leaves + leafMeta, multi-view groups degrading to even splits), else fresh panes. The resume path gates `lathLayout` on its own leaf-set match exactly as it gates the dockview blob (`reconnect.ts`). Legacy Doors (no token) degrade to neighbor-tier restore. The dual-write and the legacy reader are deleted together at stage 5 after a deprecation window.

## Testing

Source of truth: `lib/src/lib/lath/{model,layout,ops,property}.test.ts`; `lath-wall-store.test.ts`, `lath-dockview-convert.test.ts`, `LathHost.test.tsx`, `lath-wall-engine.test.ts`, `Wall.lath.test.tsx` under `lib/src/components/`.

- Core: DOM-free property tests over seeded random op sequences (tiling exactness, invariant preservation via `validate` after every op, the `ok: false` identity contract, `move` ≡ `remove`+insert, restore-tier degradation) plus golden trees, `neighbors`/`autoEdge`/`sashes` geometry, and per-op rejection cases.
- Binding (jsdom): **node identity is preserved** across every op (the no-re-parent guarantee) and DOM order stays fixed while layout order changes; frames-applied-to-style; sash drag preview/commit/cancel; zoom; the pane props contract via `componentsOverride`; store mutator/rejection/notify semantics; converter round-trips against dockview-core's real serialized shapes; engine hydration from each of the three seed sources; a flag-on `<Wall>` smoke (split, kill, dual-write save capture).
- Acceptance: rows 1–10 of the matrix below were driven live through the standalone agent-browser harness (`pnpm dev:standalone:ab`; mechanics in `.claude/skills/debug-standalone-agent-browser/SKILL.md`) with the flag on — including the exact-tier door restore from a 3-child row, sash live-resize, embed self-focus adoption, and restart restores from both the native and a legacy dockview-only blob. Re-run the applicable rows at each remaining rollout stage; all rows before stage 5's deletion sweep.

Acceptance matrix — each row is an end-to-end observable, independent of engine internals (rows 11–13 gate the stages under `## Future`):

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
| 11 | (stage 3+) Kill with animation | Fade in place, survivors tween into the space; a second kill mid-tween retargets cleanly; reduced-motion instant |
| 12 | (stage 4+) Drag a pane to a leaf edge, an ancestor edge, and center | Split-beside-pane, split-beside-column/row, and swap respectively; preview rect matches the committed result; dragging while a door is selected moves selection onto the dragged pane |
| 13 | (stage 4+) Drag a pane onto the baseboard; drag a door out | Minimize with token; restore at the hit-tested position |

Row 8's counterpart guard (a background `dor` command must never yank cross-frame focus out of the host editor) is a Wall-level policy that predates Lath — keep its check in the VS Code host after the focus-heal machinery is deleted.

## Future

**Scope: lath-rollout** — staged order; each stage lands green before the next starts (stages 1–2 are done — see above the fold):

3. **Animation** — the headless animator in the core plus the HTML adapter applying its frames: tween/retarget, enter/exit, kill fade, overlay-ring sync. Delete `lib/src/lib/kill-animation.ts`.
4. **Drag and drop** — pointer-based hierarchical DnD with the depth model below; drag-to-baseboard minimize; delete the dockview drag wiring.
5. **Deletion sweep** — remove the dockview dependency, the programmatic-activation tag, the focus-heal machinery, and the shadow models (inventory below); delete the flag and the dual-write together; promote this spec's built portions above the fold and rewrite the affected sections of [layout.md](layout.md).

Ordering constraint: lath-rollout completes before the workspace-switching stages of the **workspaces-rollout** scope (defined in [layout.md](layout.md)) — a workspace switch under Lath is "swap which tree renders," with none of dockview's active-group juggling.

Known parity gaps accepted while the flag lives: `onApiReady` never fires under Lath (the website tutorial's tut-detector needs flag-off), there is no pane DnD until stage 4, and kills/minimizes are instant until stage 3.

### Hierarchical drag and drop

Pointer events only (`pointerdown` → threshold → drag; no HTML5 DnD), so drags are testable from CDP and never race React's synthetic events.

```ts
hitTest(tree, rect, point, dragged: LeafId): DropCandidate[]
// DropCandidate = { target: DropTarget; previewRect: Rect; depth: number }, ordered innermost → outermost
```

`hitTest` is core and renderer-agnostic: it consumes a point already in Wall coordinates. The HTML adapter feeds it pointer positions; a Three.js adapter feeds it raycast intersections with the wall plane. Gesture mechanics (drag thresholds, wheel/modifier depth cycling) and the preview overlay are adapter concerns.

The depth model — the reason Lath exists beyond animation:

- The center region of a leaf yields `swap`.
- The inner edge bands of a leaf yield `edge` targets **at the leaf's level** (split beside this pane).
- When the pointer sits within a band that coincides with an ancestor boundary, `hitTest` also yields `edge` targets **at each ancestor level** — "beside this entire column," up to the root ("new full-height band at the Wall's edge"). The flatten invariant guarantees each level is a genuinely different result.
- Default resolution is the innermost candidate; scroll wheel (or a modifier, decided at implementation) cycles outward through `depth`. The binding renders the committed-if-dropped-here preview by speculatively running `move` — the overlay shows the exact resulting rect, not a heuristic hint zone.

Drag beyond the Wall onto the baseboard minimizes (remove + Door with token); dragging a Door out of the baseboard restores at the hit-tested target. One gesture system spans panes and Doors.

### Animation contract

Animation is core, not adapter: a headless **animator** turns committed layout changes into presentation frames as a pure function of time, so every renderer animates identically and tests assert real interpolated values against a fake clock (CSS transitions are untestable in jsdom and unavailable in Three.js anyway).

- `createAnimator(opts)` ingests each committed layout (`retarget(rects, meta)`) and exposes `framesAt(now): Map<LeafId, Frame>`, `Frame = { rect; opacity; layer }`. Adapters drive it from their own tick — rAF in HTML, the render loop in Three.js — and merely apply frames to their scene.
- Default motion is the house easing (440ms, `cubic-bezier(0.22, 1, 0.36, 1)`, solved in JS to match today's constants). A commit mid-flight retargets every leaf from its current interpolated frame — interruptible by construction; no `killInProgressRef`, no `animationend` + safety-timeout + double-finalize guards.
- **Enter**: `split`/`restore` callers pass `enterFrom: Edge`; the leaf's frames begin from that edge (replaces `freshlySpawnedRef`).
- **Exit**: removal is two-phase — mark the leaf dying (opacity fade in place; last-pane kills also shrink toward the bottom-right, as today), then commit `remove` and the survivors tween into the reclaimed space. The kill-confirmation flow drives the phases; the geometry never needs measuring because it was never lost.
- The `WorkspaceSelectionOverlay` (and any future chrome) reads the selected leaf's frame from the animator instead of `getBoundingClientRect` measurement, so the ring tracks moves, kills, and restores identically in every renderer.
- Reduced motion runs the same code with zero durations.

### What this deletes

| Today | Under Lath |
| --- | --- |
| `lib/src/lib/programmatic-activation.ts` + every tag site | Deleted — there are no activation events to mute |
| `onDidActivePanelChange` listener + adopt policy | Deleted — user gestures arrive as op proposals |
| `lib/src/lib/kill-animation.ts`, `killInProgressRef`, `freshlySpawnedRef` | The animation contract |
| `reassertPaneFocus`, `orchestrateKill`'s `onRemoved` heal | Deleted — nothing re-parents, nothing blurs |
| `renderer: 'always'` iframe constraint | Deleted — iframes never move in the DOM |
| `layoutAtMinimize` + signatures + `findReattachNeighbor` | Restore tokens (already the live path under the flag) |
| Spatial-nav DOM rect scanning, `paneElements` | `neighbors()` / `layout()` queries (keyboard nav already routes through `WallNav` under the flag) |
| `pickSplitDirection` | `autoEdge()` (already the live path under the flag) |
| layout.md corner cases #9, #11, #12 | Dissolve; the surviving policy statements move to the ops that own them |
| `dockview-react` / `dockview-core` dependency | Dropped from `lib/` |
