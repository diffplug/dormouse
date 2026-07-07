# Tiling Engine (Lath)

> See [glossary.md](glossary.md) for the Surface model, the `Window ⊃ Workspace ⊃ Pane ⊃ Surface` hierarchy, and the Pane / Door / baseboard / passthrough vocabulary used here.

> Status: design — nothing here is implemented yet. Dormouse's tiling layout today is dockview-react; [layout.md](layout.md) documents that implementation and remains the source of truth for all shipped behavior. This spec is the dream design for **Lath** — an in-house, headless tiling engine named for the strips hidden behind a plaster wall — written ahead of the code per the spec lifecycle in AGENTS.md.

## Future

**Scope: lath-rollout** — staged order; each stage lands green before the next starts:

1. **Core** — pure model + `layout()` + op set + restore tokens as a dependency-free module under lib/src/lib/lath/ (no UI, no DOM). Property tests and golden trees. Lands inert.
2. **Binding** — the LathHost React binding behind a dev flag, rendering the existing Wall panes at feature parity minus polish: splits, instant kills, sash resize, zoom, persistence migration. The live harness matrix from the focus-neutral branch (focus-neutral create, background/selected kills, minimize/reattach, door survival, auto-spawn) is the acceptance gate.
3. **Animation** — the animation contract below: tween/retarget, enter/exit, kill fade, overlay-ring sync. Delete `lib/src/lib/kill-animation.ts`.
4. **Drag and drop** — pointer-based hierarchical DnD with the depth model below; drag-to-baseboard minimize; delete the dockview drag wiring.
5. **Deletion sweep** — remove the dockview dependency, the programmatic-activation tag, the focus-heal machinery, and the shadow models (inventory below); promote this spec's built portions above the fold and rewrite the affected sections of [layout.md](layout.md).

Ordering constraint: lath-rollout completes before the workspace-switching stages of the **workspaces-rollout** scope (defined in [layout.md](layout.md)) — a workspace switch under Lath is "swap which tree renders," with none of dockview's active-group juggling.

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
- Lath has **no concept of selection, focus, mode, or activation**. Those stay in the Wall, where the (kind, id) selection pair and its policies already live.
- The DOM binding **never re-parents** a pane's element. Layout is geometric (absolute position + size on stable nodes), not structural.
- Non-goals: tab stacking, floating groups, popout windows (agent-browser pop-out is a separate mechanism), and the mobile compositions (MobileWall does not tile).

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

The depth model — the reason Lath exists beyond animation:

- The center region of a leaf yields `swap`.
- The inner edge bands of a leaf yield `edge` targets **at the leaf's level** (split beside this pane).
- When the pointer sits within a band that coincides with an ancestor boundary, `hitTest` also yields `edge` targets **at each ancestor level** — "beside this entire column," up to the root ("new full-height band at the Wall's edge"). The flatten invariant guarantees each level is a genuinely different result.
- Default resolution is the innermost candidate; scroll wheel (or a modifier, decided at implementation) cycles outward through `depth`. The binding renders the committed-if-dropped-here preview by speculatively running `move` — the overlay shows the exact resulting rect, not a heuristic hint zone.

Drag beyond the Wall onto the baseboard minimizes (remove + Door with token); dragging a Door out of the baseboard restores at the hit-tested target. One gesture system spans panes and Doors.

### Animation contract

Rects are data, so every layout change is natively FLIP — the binding owns one animation system:

- On commit, each surviving leaf tweens from its current **visual** rect to its new rect (transform + size), using the house easing (440ms, `cubic-bezier(0.22, 1, 0.36, 1)`, matching today's constants). Tweens are interruptible and retargetable: a second commit mid-flight retargets from the current visual position — no `killInProgressRef`, no `animationend` + safety-timeout + double-finalize guards.
- **Enter**: `split`/`restore` callers pass `enterFrom: Edge`; the leaf animates in from that edge (replaces `freshlySpawnedRef`).
- **Exit**: removal is two-phase — the binding marks the leaf dying (fade in place against the same-colored background; last-pane kills shrink toward the bottom-right, as today), then commits `remove` and the survivors tween into the reclaimed space. The kill-confirmation flow drives the phases; the geometry never needs measuring because it was never lost.
- The `WorkspaceSelectionOverlay` reads the selected leaf's **animated** rect from the binding instead of `getBoundingClientRect` polling, so the ring tracks moves, kills, and restores for free.
- Reduced motion runs the same code with zero durations.

### DOM binding

LathHost (a thin React component, the only non-headless part):

- One flat container; one stable `position: absolute` div per leaf, keyed by id. Pane content renders as ordinary React children into that div. The div moves and resizes; it is **never re-parented and never unmounted** except on remove-commit. This deletes the re-parent blur class of bugs and the iframe-reload constraint at the root rather than healing them.
- Sashes are sibling divs owned by the binding, driving `resize` with live preview.
- Dying leaves and the zoomed leaf render above the others; pointer events are disabled on dying leaves only.
- The binding never calls `.focus()` and emits no activation events. User gestures surface as **op proposals** (`onProposeOp(op)`) that the Wall commits — the Wall applies selection/focus policy at the same call sites where it lives today.

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

New serialized form: `{ version: 1, tree, doors: [{ …door, token }] }` — the tree is its own wire format. A one-way loader migrates `SerializedDockview` blobs (grid branches → splits with `dir` from `data.direction`, view sizes → normalized weights, panels → leaves) per the persisted-session migration conventions in [transport.md](transport.md); Door `layoutAtMinimize` blobs degrade to neighbor-tier tokens. The old reader is retained for a deprecation window before deletion.

### Testing

- Core: property tests (tiling exactness, invariant preservation across random op sequences, `move` ≡ `remove`+`insert`, restore-tier degradation) plus golden trees for layout rounding.
- Binding: jsdom tests asserting **node identity is preserved** across every op (the no-re-parent guarantee), enter/exit phase sequencing with fake timers, sash clamping.
- Acceptance: the agent-browser harness matrix from the focus-neutral branch, re-run per rollout stage, plus a real hierarchical drag (now drivable, since DnD is pointer-based).
