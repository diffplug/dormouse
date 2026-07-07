# Tiling Engine (Lath)

> See [glossary.md](glossary.md) for the Surface model, the `Window ⊃ Workspace ⊃ Pane ⊃ Surface` hierarchy, and the Pane / Door / baseboard / passthrough vocabulary used here.

> Status: design — nothing here is implemented yet. Dormouse's tiling layout today is dockview-react; [layout.md](layout.md) documents that implementation and remains the source of truth for all shipped behavior. This spec is the dream design for **Lath** — an in-house, headless tiling engine named for the strips hidden behind a plaster wall — written ahead of the code per the spec lifecycle in AGENTS.md.

## Future

**Scope: lath-rollout** — staged order; each stage lands green before the next starts:

1. **Core** — pure model + `layout()` + op set + restore tokens as a dependency-free module under lib/src/lib/lath/ (no UI, no DOM). Property tests and golden trees. Lands inert.
2. **Binding** — the LathHost React binding behind the dev flag, rendering the existing Wall panes at feature parity minus polish: splits, instant kills, sash resize, zoom, persistence migration, and the pane props contract below (migrating the nine pane/header components off `IDockviewPanelProps` is the largest single chunk of this stage — do it first). The acceptance matrix below is the gate.
3. **Animation** — the headless animator in the core plus the HTML adapter applying its frames: tween/retarget, enter/exit, kill fade, overlay-ring sync. Delete `lib/src/lib/kill-animation.ts`.
4. **Drag and drop** — pointer-based hierarchical DnD with the depth model below; drag-to-baseboard minimize; delete the dockview drag wiring.
5. **Deletion sweep** — remove the dockview dependency, the programmatic-activation tag, the focus-heal machinery, and the shadow models (inventory below); promote this spec's built portions above the fold and rewrite the affected sections of [layout.md](layout.md).

Ordering constraint: lath-rollout completes before the workspace-switching stages of the **workspaces-rollout** scope (defined in [layout.md](layout.md)) — a workspace switch under Lath is "swap which tree renders," with none of dockview's active-group juggling.

The dev flag is `dormouse.flags.lath` in localStorage, read once at module load — the same pattern as `dormouse.flags.abDebugLogs`. While the flag exists (stages 2–4), saves **dual-write** both formats — the Lath tree and the legacy serialized-dockview blob — so flipping the flag either direction never loses a layout; the dual-write and the flag are deleted together at stage 5.

### Why

Dormouse consumes a narrow slice of dockview — binary split tree, sash resize, drag-move, maximize, serialization; no tab stacking, no floating groups, and the mobile compositions never touch it — yet pays a broad tax for the parts of dockview's model that fight the product:

- **Activation conflates user intent with engine mechanics.** `onDidActivePanelChange` fires identically for clicks, drags, focus adoption, and every programmatic mutation. The entire `lib/src/lib/programmatic-activation.ts` mechanism exists to reconstruct intent the engine throws away, and rests on a documented assumption that dockview fires events synchronously.
- **Rendering is coupled to activation.** A pane renders only once it is its group's active panel, which forced the add-active-then-hand-back dance behind focus-neutral surface creation (layout.md corner case #12).
- **Tree rebalance re-parents DOM.** Branch collapse physically moves the survivor's subtree, blurring the focused xterm (the `reassertPaneFocus` heals) and reloading any moved `<iframe>` (the `renderer: 'always'` constraint in [dor-browser.md](dor-browser.md)).
- **Animation is adversarial.** `lib/src/lib/kill-animation.ts` is a FLIP hack against the engine: rect snapshots, `animationend` plus a safety timeout, double-finalize guards, and a re-resolve guard for dockview's `'invalid operation'` throw.
- **DnD is single-level.** Drops target one group's edges; there is no way to drop relative to an ancestor split, and native HTML5 drag events race React's synthetic ones.
- **Dormouse already keeps a shadow model.** `findReattachNeighbor` DOM inspection, `layoutAtMinimize` snapshots with structure signatures, spatial nav doing rect math over group elements — the app keeps re-deriving the tree dockview owns but does not usefully share.

The programmatic-activation refactor was the down payment: selection policy already lives at each mutation site, so when Lath removes activation events entirely, the tag that mutes them retires with nothing else to move.

### Principles and non-goals

Lath is a **headless geometry engine**. It owns the split tree, rects, animation targets, and drag hit-testing — nothing else.

- Pure core: every operation is `(tree, args) → result`. No listeners, no event emitters, no timing assumptions. Invalid operations return the input tree unchanged with `ok: false`.
- Renderer-agnostic core: the core never imports DOM (or React, or Three.js) types — tree, `layout()`, ops, hit-testing, sash geometry, and the animator are all plain-data-in, plain-data-out. The HTML adapter below is the first consumer; a Three.js adapter (serving the VR Window item in [remote-api.md](remote-api.md)'s staged remainder) is a planned second and must be able to reuse all of it unchanged.
- Lath has **no concept of selection, focus, mode, or activation**. Those stay in the Wall, where the (kind, id) selection pair and its policies already live.
- The DOM binding **never re-parents** a pane's element. Layout is geometric (absolute position + size on stable nodes), not structural.
- Non-goals: tab stacking, floating groups, popout windows (agent-browser pop-out is a separate mechanism), and the mobile compositions (MobileWall does not tile). The Three.js adapter itself is also a non-goal of lath-rollout — the scope only guarantees the core stays consumable by one.

### Core model

```ts
type LeafId = string;                        // the Wall maps Pane id ↔ leaf id 1:1
type Edge = 'left' | 'right' | 'top' | 'bottom';

type LathNode =
  | { kind: 'leaf'; id: LeafId }
  | { kind: 'split'; dir: 'row' | 'col'; children: LathChild[] };

type LathChild = { node: LathNode; weight: number };

type LathTree = { root: LathNode | null };
```

Invariants, enforced by every op and checked by a `validate(tree)` helper in tests:

- A split has ≥ 2 children; a split never directly contains a same-direction split (same-direction children are flattened on construction, i3-style). This normalization is what gives DnD its depth semantics: every ancestor boundary is a real, distinct drop level.
- Weights within a split are > 0 and normalized to sum 1.
- Leaf ids are unique. `root: null` is the empty Wall; the Wall's existing auto-spawn rule ("always one pane visible") stays app-level: any op result with a null root triggers a spawn.

Nodes are addressed by **path** (`number[]` of child indexes from the root). Paths are ephemeral — valid only until the next op — and never persisted.

Zoom is not in the tree. It is presentation state in the binding (the zoomed leaf renders full-rect on top; the tree and all other rects are unchanged beneath), replacing `maximizeGroup`.

### Layout

```ts
layout(tree: LathTree, rect: Rect, opts: { gap: number; minLeaf: Size }): Map<LeafId, Rect>
```

Pure. Splits divide their axis by weight; sizes round to integer pixels with the remainder distributed left-to-right so adjacent panes never seam or overlap. Weights are clamped at layout time against `minLeaf` (stored weights are never rewritten by layout). Property tests assert: rects exactly tile `rect` minus gaps, no overlap, every leaf present.

Two derived pure queries replace today's DOM inspection:

- `neighbors(tree, rect, id, direction) → LeafId | null` — spatial navigation without `resolvePaneGroupElement` rect scanning.
- `autoEdge(tree, rect, id) → Edge` — the aspect-ratio split heuristic, replacing `pickSplitDirection`.

### Operations

All ops return `{ tree: LathTree; ok: boolean }` plus op-specific fields. All are pure and synchronous.

| Op | Shape | Notes |
| --- | --- | --- |
| `split` | `(tree, at: LeafId, edge, newId)` | Inserts `newId` beside `at`, extending the parent split when directions match (flatten invariant) or nesting a new one. New leaf takes half of `at`'s weight. |
| `remove` | `(tree, id)` | Removes the leaf, collapses single-child splits, re-flattens. Returns a `RestoreToken` (below). |
| `replace` | `(tree, oldId, newId)` | Atomic identity swap in place — the `dor iframe` replace-untouched-terminal case becomes one op with no transient add/remove states. |
| `move` | `(tree, id, target: DropTarget)` | Remove + insert as one op; weight follows the leaf. |
| `swap` | `(tree, a, b)` | Leaf identity swap (drag-onto-center, `swapTerminals` companion). |
| `resize` | `(tree, splitPath, boundary, deltaPx, rect, opts)` | Adjusts the two weights adjacent to `boundary`, clamped by `minLeaf`. Streamed during a sash drag; the final tree commits on pointerup. |
| `restore` | `(tree, token)` | Reinserts a removed leaf, best effort (below). |

Because ops are cheap pure functions, speculative evaluation is free — DnD previews and sash live-resize run `layout(op(tree, …).tree, …)` per frame without committing.

### Restore tokens (Doors)

`remove` returns a token capturing the leaf's ancestry: the sibling it sat beside, the edge relationship, its weight, and a structural fingerprint of the surrounding split. `restore` applies a three-tier policy mirroring today's reattach ladder in `handleReattach`:

1. exact — the fingerprinted context still exists: reinsert at the original spot with the original weight;
2. neighbor — the sibling still exists: split beside it on the original edge;
3. fallback — split beside a caller-supplied reference leaf via `autoEdge`.

Tokens serialize with Doors, replacing `layoutAtMinimize` + `getLayoutStructureSignature` + `findReattachNeighbor` and their DOM inspection.

### Hierarchical drag and drop

Pointer events only (`pointerdown` → threshold → drag; no HTML5 DnD), so drags are testable from CDP and never race React's synthetic events.

```ts
type DropTarget =
  | { kind: 'edge'; path: number[]; edge: Edge }   // insert beside the node at path, at its parent's level
  | { kind: 'swap'; leaf: LeafId };

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
- The `WorkspaceSelectionOverlay` (and any future chrome) reads the selected leaf's frame from the animator instead of `getBoundingClientRect` polling, so the ring tracks moves, kills, and restores identically in every renderer.
- Reduced motion runs the same code with zero durations.

### Adapters; the HTML adapter (LathHost)

An adapter owns exactly three things: mapping input into Wall coordinates (pointer position in HTML; a controller/gaze raycast against the wall plane in a Three.js adapter), applying animator frames to its scene each tick, and hosting pane content. Layout, ops, hit-testing, sash geometry, and animation timelines are core and shared.

LathHost, the HTML adapter (a thin React component, the only non-headless part of lath-rollout):

- One flat container; one stable `position: absolute` div per leaf, keyed by id. Pane content renders as ordinary React children into that div. The div moves and resizes; it is **never re-parented and never unmounted** except on remove-commit. This deletes the re-parent blur class of bugs and the iframe-reload constraint at the root rather than healing them.
- Sashes render from core geometry — `sashes(tree, rect, opts) → { splitPath, boundary, rect }[]` — as sibling divs; the adapter draws them, sets cursors, and captures their drags, streaming `resize` with live preview.
- Dying leaves and the zoomed leaf render above the others; pointer events are disabled on dying leaves only.
- The binding never calls `.focus()` and emits no activation events. User gestures surface as **op proposals** (`onProposeOp(op)`) that the Wall commits — the Wall applies selection/focus policy at the same call sites where it lives today.

### Pane props contract

The largest hidden chunk of stage 2: nine pane/header components are currently coupled to dockview's panel objects (`IDockviewPanelProps` / `IDockviewPanelHeaderProps`) — `TerminalPanel`, `BrowserPanel`, `AgentBrowserPanel`, `IframePanel`, `TerminalPaneHeader`, `SurfacePaneHeader`, plus `use-pane-chrome` and `use-surface-visibility` — reading `api.id` / `params` / `title` and calling `api.updateParameters` / `api.setTitle` (~12 call sites). Under Lath there is no panel object, so stage 2 introduces a plain props contract supplied by LathHost:

- **Read side**: `{ id, params, title }` as ordinary React props. Title-change and params-change subscriptions (`onDidTitleChange`, `updateParameters` echoes) become ordinary re-renders — the data lives in a Wall-owned per-leaf metadata map (`id → { params, title }`), which is also what persists (today this state rides inside dockview's serialized panel blobs).
- **Write side**: `{ setTitle(id, t), updateParams(id, patch) }` actions writing that same map. The render-swap and `wsPort`-refresh flows (`api.updateParameters` sites in `Wall.tsx`) route through `updateParams`; door param refreshes already write door state directly and are unaffected.
- **Headers** render into a header slot of the leaf's stable div as plain components — no dockview tab wrapper, which also retires the native-pointerdown-races-React-synthetic-events class of bugs (the header-kill activation ordering).
- **Visibility**: with no `onlyWhenVisible` renderer, a mounted leaf is always visible; `use-surface-visibility` reduces to "leaf present in the tree" (Doors remain unmounted, as today).

Do this migration first within stage 2 — it is mechanical, independently verifiable (components render under a test harness with plain props), and everything else in the stage depends on it.

### What this deletes

| Today | Under Lath |
| --- | --- |
| `lib/src/lib/programmatic-activation.ts` + every tag site | Deleted — there are no activation events to mute |
| `onDidActivePanelChange` listener + adopt policy | Deleted — user gestures arrive as op proposals |
| `lib/src/lib/kill-animation.ts`, `killInProgressRef`, `freshlySpawnedRef` | The animation contract |
| `reassertPaneFocus`, `orchestrateKill`'s `onRemoved` heal | Deleted — nothing re-parents, nothing blurs |
| `renderer: 'always'` iframe constraint | Deleted — iframes never move in the DOM |
| `layoutAtMinimize` + signatures + `findReattachNeighbor` | Restore tokens |
| Spatial-nav DOM rect scanning, `paneElements` | `neighbors()` / `layout()` queries |
| `pickSplitDirection` | `autoEdge()` |
| layout.md corner cases #9, #11, #12 | Dissolve; the surviving policy statements move to the ops that own them |
| `dockview-react` / `dockview-core` dependency | Dropped from `lib/` |

### Persistence and migration

New serialized form: `{ version: 1, tree, leafMeta, doors: [{ …door, token }] }` — the tree is its own wire format, and `leafMeta` carries the per-leaf `{ params, title }` map from the pane props contract (state that today rides inside dockview's serialized panel blobs). A one-way loader migrates `SerializedDockview` blobs (grid branches → splits with `dir` from `data.direction`, view sizes → normalized weights, panels → leaves + leafMeta) per the persisted-session migration conventions in [transport.md](transport.md); Door `layoutAtMinimize` blobs degrade to neighbor-tier tokens. During stages 2–4 saves dual-write both formats (see the flag note under the scope above); the legacy reader and dual-write are deleted together at stage 5 after a deprecation window.

### Testing

- Core: property tests (tiling exactness, invariant preservation across random op sequences, `move` ≡ `remove`+`insert`, restore-tier degradation) plus golden trees for layout rounding, and animator tests against a fake clock — real interpolated rects/opacities, retarget mid-flight, enter/exit phase ordering, reduced-motion zero-duration. No DOM anywhere in these.
- Binding: jsdom tests asserting **node identity is preserved** across every op (the no-re-parent guarantee), frames-applied-to-style wiring, sash clamping, and the pane props contract (components render with plain props).
- Acceptance: the live matrix below, driven through the standalone agent-browser harness (`pnpm dev:standalone:ab`; mechanics — typing into xterm, synthetic Enter, ring probing, group mapping — are documented in the in-repo skill at `.claude/skills/debug-standalone-agent-browser/SKILL.md`). Run the applicable rows at each rollout stage; all rows before stage 5's deletion sweep.

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
| 11 | (stage 3+) Kill with animation | Fade in place, survivors tween into the space; a second kill mid-tween retargets cleanly; reduced-motion instant |
| 12 | (stage 4+) Drag a pane to a leaf edge, an ancestor edge, and center | Split-beside-pane, split-beside-column/row, and swap respectively; preview rect matches the committed result; dragging while a door is selected moves selection onto the dragged pane |
| 13 | (stage 4+) Drag a pane onto the baseboard; drag a door out | Minimize with token; restore at the hit-tested position |

Row 8's counterpart guard (a background `dor` command must never yank cross-frame focus out of the host editor) is a Wall-level policy that predates Lath — keep its check in the VS Code host after the focus-heal machinery is deleted.
