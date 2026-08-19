// The Lath-side Wall store: the headless state machine + geometry + enter hints over
// the stage-1 core (docs/specs/tiling-engine.md → "The wall store and engine"). It
// owns the split tree, a per-leaf metadata map, zoom, the reported layout geometry,
// and the pending enter-hint map, and exposes a `useSyncExternalStore`-compatible
// snapshot. Every mutator applies exactly one pure core op; a rejected op
// (`ok: false`) commits nothing and returns the failure verbatim, so callers can
// distinguish "did nothing" from "changed".
//
// This is the sole state authority: every state op and geometry query reaches it
// directly as `lath.store.*`. The engine (`lath-wall-engine.ts`) only layers
// presentation / vocabulary / persistence conveniences over it — it re-exports none
// of these mutators or queries.
//
// What lives here is *geometry + metadata only*: there is no selection, focus,
// mode, or activation anywhere in this file — those stay in the Wall, which wires
// itself to this store.

import {
  type Edge,
  type LathTree,
  type LeafId,
  type Rect,
  findLeafPath,
  leafTree,
  leaves,
  oppositeEdge,
} from '../../lib/lath/model';
import type { EnterFrom } from '../../lib/lath/animator';
import { type Direction, type LayoutOpts, autoEdge, layout, neighbors } from '../../lib/lath/layout';
import {
  type DropTarget,
  type RestoreToken,
  insert,
  move,
  remove,
  replace,
  resize,
  restore,
  split,
  swap,
} from '../../lib/lath/ops';
import type { LeafMeta } from '../../lib/lath/persistence';
import { PANE_GUTTER_PX } from '../design';

// Re-exported for the wall modules that read/write the store's meta map — the type
// itself lives with the persisted-layout wire format it serializes into.
export type { LeafMeta };

/** The geometry the wall lays out with: `gap` is the pane-to-pane gutter, `minLeaf`
 *  a comfortable minimum pane size. Pure data beside the store's geometry contract —
 *  the HTML adapter (LathHost) lays out with it and reports it back via
 *  `setLayoutGeometry`, so the store's queries (restore / resize / neighbors /
 *  autoEdge) match the screen. */
export const LATH_LAYOUT_OPTS: LayoutOpts = { gap: PANE_GUTTER_PX, minLeaf: { width: 100, height: 60 } };

/** An immutable view of the store. `getSnapshot` returns the same object identity
 *  until the next commit, as `useSyncExternalStore` requires. */
export type LathWallSnapshot = {
  tree: LathTree;
  leafMeta: ReadonlyMap<string, LeafMeta>;
  /** Parked leaves: mounted by the adapter but absent from the tree, so they keep
   *  their DOM (an `<iframe>` never reloads) while showing nothing
   *  (docs/specs/tiling-engine.md → "Parked leaves"). Insertion-ordered, so the cap
   *  evicts the oldest. Disjoint from `leafMeta` by construction — a leaf is either
   *  laid out or parked, never both — which is what keeps parked meta out of the
   *  persisted layout without a filter. */
  parked: ReadonlyMap<string, ParkedLeaf>;
  zoomedId: string | null;
  /** Monotonic; bumps on every commit (meta writes and zoom included) so effects
   *  can key off "something committed" without diffing the tree. */
  revision: number;
};

/** A parked leaf: the meta it keeps updating while hidden, plus the rect it held
 *  when it left the tree. The adapter renders it there rather than at zero size, so
 *  the guest document never sees a 0x0 viewport and reflows on the way out and back.
 *  `rect` is null only for a leaf parked before it was ever laid out (`dor iframe
 *  --minimize` creates and minimizes in one commit) or with no geometry reported. */
export type ParkedLeaf = { meta: LeafMeta; rect: Rect | null };

/** How many Surfaces may stay parked at once. Each parked leaf is a live document —
 *  an iframe still running its scripts, timers, and sockets — so "preserve state" has
 *  to stop somewhere. `parkLeaf` enforces this itself, in the same commit, so no
 *  caller can forget; past the cap the oldest park is dropped and that Surface reverts
 *  to reattaching by reload. Generous enough that a normal baseboard never hits it;
 *  the workspaces-rollout switch (which parks a whole Workspace at a time) is what
 *  makes a bound necessary at all. */
export const MAX_PARKED_SURFACES = 8;

/** A leaf's meta wherever it lives — laid out or parked. The two maps are disjoint,
 *  so the lookup order is arbitrary. The single reader of that disjointness: the
 *  store, the engine's `getMeta`, and the adapter all resolve meta through here. */
export function leafMetaIn(snapshot: LathWallSnapshot, id: LeafId): LeafMeta | undefined {
  return snapshot.leafMeta.get(id) ?? snapshot.parked.get(id)?.meta;
}

/** Where a new leaf lands: beside `refId` on `edge`. `null` (or a `refId` that is
 *  gone) means "beside the last leaf via `autoEdge`", or "become the root" when the
 *  tree is empty. */
export type AddLeafPosition = { refId: string; edge: Edge } | null;

export type LathWallStore = {
  /** `useSyncExternalStore` reader — stable identity between commits. */
  getSnapshot(): LathWallSnapshot;
  /** `useSyncExternalStore` subscriber — returns an unsubscribe. */
  subscribe(listener: () => void): () => void;

  /** Initial hydration: replace the tree and meta wholesale (clears zoom). */
  seed(tree: LathTree, meta: ReadonlyArray<readonly [LeafId, LeafMeta]>): void;

  /** Add `id` (with `meta`) beside `position.refId` on its edge, or beside the
   *  last leaf via `autoEdge`, or as the root of an empty tree. Rejects (`ok:
   *  false`, no commit) if `id` already exists or the underlying `split` fails. */
  addLeaf(id: LeafId, meta: LeafMeta, position: AddLeafPosition): { ok: boolean };

  /** Remove `id` and delete its meta. On success returns the core `RestoreToken`
   *  for the caller to persist on the resulting Door. */
  removeLeaf(id: LeafId): { ok: boolean; token: RestoreToken | null };

  /** `removeLeaf`, except the leaf's meta and last rect move into `parked` instead
   *  of being deleted — one commit, so the adapter never sees a frame where the id
   *  is in neither map and would unmount its DOM. Trims the oldest parks past
   *  `MAX_PARKED_SURFACES` in that same commit. The Wall picks this over
   *  `removeLeaf` for Surfaces whose state lives in the DOM
   *  (docs/specs/tiling-engine.md → "Parked leaves"). */
  parkLeaf(id: LeafId): { ok: boolean; token: RestoreToken | null };

  /** Drop a parked leaf without restoring it — the adapter unmounts it and its
   *  DOM state is gone. Used when a parked Surface is killed outright. No-op if
   *  `id` is not parked. */
  unparkLeaf(id: LeafId): void;

  /** Atomically swap `oldId` for `newId` in place, moving meta from the old id to
   *  the new one — the `dor iframe` replace-untouched-terminal case, with no
   *  transient add/remove states. */
  replaceLeaf(oldId: LeafId, newId: LeafId, meta: LeafMeta): { ok: boolean };

  /** Reinsert a removed leaf from its `token` (three-tier core `restore`), setting
   *  its meta. `opts.fallbackRef` is the live leaf the fallback tier splits beside;
   *  the store supplies its last layout geometry so that tier can `autoEdge`. */
  restoreLeaf(
    meta: LeafMeta,
    token: RestoreToken,
    opts?: { fallbackRef?: LeafId },
  ): { ok: boolean; tier: 'exact' | 'neighbor' | 'fallback' | null };

  /** Exchange two leaf identities. Meta stays keyed by id, so each leaf's title /
   *  params follow its id automatically — there is no companion title swap. */
  swapLeaves(a: LeafId, b: LeafId): { ok: boolean };

  /** Move an existing leaf onto a hit-tested drop `target` (core `move`, one commit).
   *  Meta follows the id, so nothing else moves. Rejected op → no commit. */
  moveLeaf(id: LeafId, target: DropTarget): { ok: boolean };

  /** Insert a NEW leaf onto a hit-tested drop `target` (core `insert` at the default
   *  0.5 split), setting its meta — the Door drag-out reattach. Rejected op → no
   *  commit. */
  insertLeaf(id: LeafId, meta: LeafMeta, target: DropTarget): { ok: boolean };

  /** Commit a sash resize (one core `resize`) using the store's last reported
   *  geometry. Called once on pointerup; the live drag preview is LathHost-local.
   *  Rejects if no geometry has been reported yet or the op fails. */
  resizeBoundary(splitPath: number[], boundary: number, deltaPx: number): { ok: boolean };

  /** Meta write: set a leaf's fallback title. No-op if unchanged or absent.
   *  Reaches parked leaves too — a parked Surface keeps running and keeps
   *  reporting. */
  setTitle(id: LeafId, title: string): void;
  /** Meta write: merge `patch` into a leaf's params. No-op if the leaf is absent.
   *  Reaches parked leaves too. */
  updateParams(id: LeafId, patch: Record<string, unknown>): void;

  /** Presentation-only zoom target (the tree is untouched). No-op if unchanged. */
  setZoomed(id: LeafId | null): void;

  /** LathHost reports the rect + opts it renders with; the store keeps the latest
   *  to feed `restoreLeaf`, `resizeBoundary`, `neighborOf`, and `addLeaf`'s
   *  `autoEdge`. Not part of the snapshot — it drives queries, not rendering — so
   *  it never notifies. */
  setLayoutGeometry(rect: Rect, opts: LayoutOpts): void;

  /** Record the edge a soon-to-be-added leaf should enter from (drained at the next
   *  retarget). An explicit call always wins — the mutators derive a hint internally
   *  from the edge they commit, but only when none was pre-set for that id (e.g. the
   *  auto-spawn `'top-left'` policy override). Side state, never in the snapshot. */
  setEnterHint(id: LeafId, enterFrom: EnterFrom): void;
  /** Drain and return every pending enter hint (LathHost consumes these when it
   *  ingests a committed layout). */
  consumeEnterHints(): Map<string, EnterFrom>;

  /** Pre-order leaf ids of the current tree. */
  leafIds(): LeafId[];
  /** Parked leaf ids in park order (oldest first). */
  parkedIds(): LeafId[];
  /** Whether `id` is a leaf in the current tree. */
  has(id: LeafId): boolean;
  /** Nearest neighbor of `id` in `direction` under the last reported geometry, or
   *  null (no neighbor, or no geometry yet). */
  neighborOf(id: LeafId, direction: Direction): LeafId | null;
  /** Aspect-ratio split edge for `id` under the last reported geometry (`autoEdge`);
   *  `'right'` when there is no geometry yet or the leaf is absent. */
  autoEdgeFor(id: LeafId): Edge;
};

const EMPTY_TREE: LathTree = { root: null };

export function createLathWallStore(): LathWallStore {
  let snapshot: LathWallSnapshot = Object.freeze({
    tree: EMPTY_TREE,
    leafMeta: new Map<string, LeafMeta>(),
    parked: new Map<string, ParkedLeaf>(),
    zoomedId: null,
    revision: 0,
  });
  // Last geometry LathHost rendered with; drives queries, never part of a snapshot.
  let geometry: { rect: Rect; opts: LayoutOpts } | null = null;
  // Enter hints drained per retarget by LathHost. Side state, never in the snapshot.
  const enterHints = new Map<string, EnterFrom>();
  const listeners = new Set<() => void>();

  /** Derive an enter hint from the edge a mutator actually committed, unless an
   *  explicit `setEnterHint` already named this leaf (a policy override wins). The
   *  leaf grows FROM the boundary it shares with its reference — the opposite edge. */
  function deriveEnterHint(id: LeafId, placementEdge: Edge): void {
    if (enterHints.has(id)) return;
    enterHints.set(id, oppositeEdge(placementEdge));
  }

  function notify(): void {
    for (const listener of listeners) listener();
  }

  /** Publish a new frozen snapshot (revision bumped) and notify. `leafMeta` is
   *  reused by identity when a commit does not touch meta, so pure tree ops never
   *  clone the map; meta-changing commits pass a freshly-built map. */
  function commit(next: {
    tree?: LathTree;
    leafMeta?: ReadonlyMap<string, LeafMeta>;
    parked?: ReadonlyMap<string, ParkedLeaf>;
    zoomedId?: string | null;
  }): void {
    snapshot = Object.freeze({
      tree: next.tree ?? snapshot.tree,
      leafMeta: next.leafMeta ?? snapshot.leafMeta,
      parked: next.parked ?? snapshot.parked,
      zoomedId: next.zoomedId !== undefined ? next.zoomedId : snapshot.zoomedId,
      revision: snapshot.revision + 1,
    });
    notify();
  }

  function cloneMeta(): Map<string, LeafMeta> {
    return new Map(snapshot.leafMeta);
  }

  /** Write a leaf's meta back into whichever map holds it. A parked Surface keeps
   *  running while hidden (an iframe navigating, an agent-browser mirroring its
   *  URL), so its meta must stay live or a reattach would show stale params. */
  function writeMeta(id: LeafId, meta: LeafMeta): void {
    const cur = snapshot.parked.get(id);
    if (cur) {
      commit({ parked: new Map(snapshot.parked).set(id, { ...cur, meta }) });
      return;
    }
    const m = cloneMeta();
    m.set(id, meta);
    commit({ leafMeta: m });
  }

  /** A leaf re-entering the tree stops being parked, in the SAME commit as the op
   *  that admits it — the adapter must never see it in neither map. Returns the
   *  new parked map, or the existing one untouched when `id` was not parked. */
  function unparked(id: LeafId): ReadonlyMap<string, ParkedLeaf> {
    if (!snapshot.parked.has(id)) return snapshot.parked;
    const p = new Map(snapshot.parked);
    p.delete(id);
    return p;
  }

  /** Park order, oldest first, trimmed to the cap. A leaf in the tree is never also
   *  parked (the maps are disjoint), so the new entry always appends — which is why
   *  trimming from the front can never evict the park that just happened. */
  function parkedWith(id: LeafId, entry: ParkedLeaf): ReadonlyMap<string, ParkedLeaf> {
    const p = new Map(snapshot.parked).set(id, entry);
    for (const oldest of p.keys()) {
      if (p.size <= MAX_PARKED_SURFACES) break;
      p.delete(oldest);
    }
    return p;
  }

  /** The shared body of `removeLeaf` / `parkLeaf`: one core `remove`, differing only
   *  in whether the departing leaf's meta is deleted or retained (with the rect it
   *  was last laid out at, read from the geometry the adapter reported). */
  function detachLeaf(id: LeafId, park: boolean): { ok: boolean; token: RestoreToken | null } {
    const r = remove(snapshot.tree, id);
    if (!r.ok) return { ok: false, token: null };
    const cur = snapshot.leafMeta.get(id);
    const m = cloneMeta();
    m.delete(id);
    const p = park && cur
      ? parkedWith(id, {
          meta: cur,
          rect: geometry ? layout(snapshot.tree, geometry.rect, geometry.opts).get(id) ?? null : null,
        })
      : snapshot.parked;
    // `zoomedId` always names a live leaf (a store invariant, like meta): clear it
    // when the leaf it named departs.
    commit({
      tree: r.tree,
      leafMeta: m,
      parked: p,
      ...(snapshot.zoomedId === id ? { zoomedId: null } : {}),
    });
    return { ok: true, token: r.token };
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    seed(tree, meta) {
      // Parked leaves survive a seed, minus any the seed itself admits to the tree:
      // hydration starts with none parked, and the workspaces-rollout switch parks
      // the outgoing Workspace's Surfaces and then seeds the incoming one, so
      // clearing here would unmount exactly what parking just preserved.
      const p = new Map(snapshot.parked);
      for (const [id] of meta) p.delete(id);
      commit({ tree, leafMeta: new Map(meta), parked: p, zoomedId: null });
    },

    addLeaf(id, meta, position) {
      const tree = snapshot.tree;

      // Empty tree: the new leaf becomes the root (there is no core op for
      // inserting into an empty tree — the Wall seeds it here).
      if (tree.root === null) {
        const m = cloneMeta();
        m.set(id, meta);
        commit({ tree: leafTree(id), leafMeta: m, parked: unparked(id) });
        return { ok: true };
      }

      let refId: LeafId | undefined;
      let edge: Edge;
      if (position && findLeafPath(tree, position.refId) !== null) {
        refId = position.refId;
        edge = position.edge;
      } else {
        const ids = leaves(tree);
        refId = ids[ids.length - 1];
        edge = refId !== undefined && geometry
          ? autoEdge(tree, geometry.rect, refId, geometry.opts)
          : 'right';
      }
      if (refId === undefined) return { ok: false };

      const r = split(tree, refId, edge, id);
      if (!r.ok) return { ok: false };
      // Enter from the boundary the split lands beside (opposite the placement edge) —
      // including the null-position `autoEdge` fallback, so those adds animate too.
      deriveEnterHint(id, edge);
      const m = cloneMeta();
      m.set(id, meta);
      commit({ tree: r.tree, leafMeta: m, parked: unparked(id) });
      return { ok: true };
    },

    removeLeaf: (id) => detachLeaf(id, false),

    parkLeaf: (id) => detachLeaf(id, true),

    unparkLeaf(id) {
      const p = unparked(id);
      if (p === snapshot.parked) return;
      commit({ parked: p });
    },

    replaceLeaf(oldId, newId, meta) {
      const r = replace(snapshot.tree, oldId, newId);
      if (!r.ok) return { ok: false };
      const m = cloneMeta();
      m.delete(oldId);
      m.set(newId, meta);
      // A replace preserves the slot, so retarget a zoom that named the old leaf.
      commit({
        tree: r.tree,
        leafMeta: m,
        parked: unparked(newId),
        ...(snapshot.zoomedId === oldId ? { zoomedId: newId } : {}),
      });
      return { ok: true };
    },

    restoreLeaf(meta, token, opts) {
      const r = restore(snapshot.tree, token, {
        fallbackRef: opts?.fallbackRef,
        rect: geometry?.rect,
        layoutOpts: geometry?.opts,
      });
      if (!r.ok) return { ok: false, tier: r.tier };
      // Enter from the boundary the door lands beside (opposite the token's edge). An
      // exact-tier restore may land on a different edge — acceptable; entry is cosmetic.
      deriveEnterHint(token.leafId, token.edge);
      const m = cloneMeta();
      m.set(token.leafId, meta);
      commit({ tree: r.tree, leafMeta: m, parked: unparked(token.leafId) });
      return { ok: true, tier: r.tier };
    },

    swapLeaves(a, b) {
      const r = swap(snapshot.tree, a, b);
      if (!r.ok) return { ok: false };
      // Meta is keyed by id and untouched by a swap, so reuse the same map.
      commit({ tree: r.tree });
      return { ok: true };
    },

    moveLeaf(id, target) {
      const r = move(snapshot.tree, id, target);
      if (!r.ok) return { ok: false };
      // Meta is keyed by id and untouched by a move, so reuse the same map.
      commit({ tree: r.tree });
      return { ok: true };
    },

    insertLeaf(id, meta, target) {
      const r = insert(snapshot.tree, id, target);
      if (!r.ok) return { ok: false };
      // A successful insert is always an edge target — enter from its opposite edge.
      if (target.kind === 'edge') deriveEnterHint(id, target.edge);
      const m = cloneMeta();
      m.set(id, meta);
      commit({ tree: r.tree, leafMeta: m, parked: unparked(id) });
      return { ok: true };
    },

    resizeBoundary(splitPath, boundary, deltaPx) {
      if (!geometry) return { ok: false };
      const r = resize(snapshot.tree, splitPath, boundary, deltaPx, geometry.rect, geometry.opts);
      if (!r.ok) return { ok: false };
      commit({ tree: r.tree });
      return { ok: true };
    },

    setTitle(id, title) {
      const cur = leafMetaIn(snapshot, id);
      if (!cur || cur.title === title) return;
      writeMeta(id, { ...cur, title });
    },

    updateParams(id, patch) {
      const cur = leafMetaIn(snapshot, id);
      if (!cur) return;
      writeMeta(id, { ...cur, params: { ...(cur.params ?? {}), ...patch } });
    },

    setZoomed(id) {
      if (snapshot.zoomedId === id) return;
      commit({ zoomedId: id });
    },

    setLayoutGeometry(rect, opts) {
      // Reject a degenerate (zero-area) measurement so it can never poison the
      // geometry-derived queries (`autoEdge`, `neighbors`). `autoEdge` on a 0×0 rect
      // returns `'bottom'` for every split, so a seed reading it would stack every
      // pane vertically — strictly worse than the `!geometry` fallback (`'right'`).
      // Keeping the last good geometry (or none yet) lets those readers hit their
      // benign fallback until the container actually has a size.
      if (rect.width <= 0 || rect.height <= 0) return;
      geometry = { rect, opts };
    },

    setEnterHint(id, enterFrom) {
      enterHints.set(id, enterFrom);
    },
    consumeEnterHints() {
      const drained = new Map(enterHints);
      enterHints.clear();
      return drained;
    },

    leafIds: () => leaves(snapshot.tree),
    parkedIds: () => [...snapshot.parked.keys()],
    has: (id) => findLeafPath(snapshot.tree, id) !== null,
    neighborOf(id, direction) {
      if (!geometry) return null;
      return neighbors(snapshot.tree, geometry.rect, id, direction, geometry.opts);
    },
    autoEdgeFor(id) {
      if (!geometry) return 'right';
      return autoEdge(snapshot.tree, geometry.rect, id, geometry.opts);
    },
  };
}
