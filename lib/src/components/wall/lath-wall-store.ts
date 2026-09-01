// Sole Lath state authority: geometry + metadata, never selection/focus/mode.
// Each mutator applies one core op; rejection commits and notifies nothing.
// See docs/specs/tiling-engine.md → "The wall store and engine".

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
import { type Direction, type LayoutOpts, autoEdge, neighbors, nodeRectAtPath } from '../../lib/lath/layout';
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

/** Shared by LathHost rendering and the store's geometry-dependent queries. */
export const LATH_LAYOUT_OPTS: LayoutOpts = { gap: PANE_GUTTER_PX, minLeaf: { width: 100, height: 60 } };

/** An immutable view of the store. `getSnapshot` returns the same object identity
 *  until the next commit, as `useSyncExternalStore` requires. */
export type LathWallSnapshot = {
  tree: LathTree;
  /** Meta for tree leaves and Doors alike; no runtime Door metadata copy. */
  leafMeta: ReadonlyMap<string, LeafMeta>;
  /** Mounted detached leaves in eviction order; null means never laid out. */
  parked: ReadonlyMap<string, Rect | null>;
  zoomedId: string | null;
  /** Monotonic; bumps on every commit (meta writes and zoom included) so effects
   *  can key off "something committed" without diffing the tree. */
  revision: number;
};

/** Cap live parked documents; oldest DOM is evicted while metadata survives. */
export const MAX_PARKED_SURFACES = 8;

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
   *  for the caller to persist on the resulting Door. Destroys the leaf's meta —
   *  use `doorLeaf` to detach one that lives on as a Door. */
  removeLeaf(id: LeafId): { ok: boolean; token: RestoreToken | null };

  /** Detach a leaf into a Door: out of the tree, but its meta STAYS — the store
   *  remains the single authority for a Doored Surface's title/params, which keep
   *  changing while it is minimized. `opts.park` additionally keeps the leaf mounted
   *  at the rect it held, for Surfaces whose state lives in the DOM, and trims the
   *  oldest park past `MAX_PARKED_SURFACES` in the same commit — one commit, so the
   *  adapter never sees a frame where a parked id would unmount
   *  (docs/specs/tiling-engine.md → "Parked leaves"). Pair with `forgetLeaf` when
   *  the Door is destroyed. */
  doorLeaf(id: LeafId, opts?: { park?: boolean }): { ok: boolean; token: RestoreToken | null };

  /** Register a leaf that is BORN minimized — meta only, no tree entry — so every
   *  Door has store metadata regardless of how it was created (`dor split` against
   *  another Door never has a pane to detach). `doorLeaf` cannot serve: it needs the
   *  leaf in the tree. No-op if `id` is already a leaf or a Door. */
  addDoor(id: LeafId, meta: LeafMeta): void;

  /** Destroy a Door: drop its retained meta and unmount it if parked. The counterpart
   *  to `doorLeaf`/`addDoor`, called when a minimized Surface is killed rather than
   *  reattached. No-op if `id` is not a Door. */
  forgetLeaf(id: LeafId): void;

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
   *  Reaches parked and cap-evicted leaves too — async browser metadata can arrive
   *  after either transition. */
  setTitle(id: LeafId, title: string): void;
  /** Meta write: merge `patch` into a leaf's params. No-op if the leaf is absent.
   *  Reaches parked and cap-evicted leaves too. */
  updateParams(id: LeafId, patch: Record<string, unknown>): void;
  /** Meta write: replace a leaf's whole meta — component pair, title and params
   *  in ONE commit. The in-place kind change behind the `dor tool` take-over
   *  (`docs/specs/dor-tool.md` -> Take-over): the id never moves, so the Session
   *  and its scrollback are untouched. One commit because a body swapped ahead
   *  of its params would render a tool whose params are still a terminal's.
   *  No-op if the leaf is absent. */
  setMeta(id: LeafId, meta: LeafMeta): void;

  /** Presentation-only zoom target (the tree is untouched). No-op if unchanged. */
  setZoomed(id: LeafId | null): void;

  /** LathHost reports the rect + opts it renders with; the store keeps the latest
   *  to feed `restoreLeaf`, `resizeBoundary`, `neighborOf`, and `addLeaf`'s
   *  `autoEdge`. Not part of the snapshot — it drives queries, not rendering — so
   *  it never notifies. */
  setLayoutGeometry(rect: Rect, opts: LayoutOpts): void;

  /** Record where a soon-to-be-added leaf should enter from (drained at the next
   *  retarget). An explicit call wins over edge derivation (e.g. the auto-spawn
   *  `'top-left'` policy override); a parked leaf's held-viewport rect overrides both.
   *  Side state, never in the snapshot. */
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
    parked: new Map<string, Rect | null>(),
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
   *  leaf grows FROM the boundary it shares with its reference — the opposite edge.
   *  `admit` may override the result with a parked leaf's held rect afterward. */
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
    parked?: ReadonlyMap<string, Rect | null>;
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

  /** `map` minus `id`, reusing the same map when `id` is absent, so an untouched map
   *  keeps its identity across commits (the snapshot's reuse contract). */
  function withoutKey<V>(map: ReadonlyMap<string, V>, id: LeafId): ReadonlyMap<string, V> {
    if (!map.has(id)) return map;
    const next = new Map(map);
    next.delete(id);
    return next;
  }

  /** What a leaf re-entering the tree owes, in the SAME commit as the op that admits
   *  it: it stops being parked, and — if it was — it re-enters from the rect it held
   *  rather than from a collapsed edge. A parked id must never be absent from both
   *  the tree and `parked` for an intermediate commit, or the adapter would unmount
   *  the DOM the park exists to preserve. Metadata needs nothing here: it never left.
   *
   *  Runs after any `deriveEnterHint`, so the held rect wins over a derived edge and
   *  over an explicit `setEnterHint`: viewport safety beats a cosmetic hint. A null
   *  held rect (parked before it was ever laid out) suppresses the hint instead,
   *  which still avoids handing the guest a 0×N viewport. Returns nothing when the
   *  ids were not parked, so an admit that frees nothing commits nothing. */
  function admit(ids: Iterable<LeafId>): { parked?: ReadonlyMap<string, Rect | null> } {
    let parked = snapshot.parked;
    for (const id of ids) {
      if (!parked.has(id)) continue;
      const held = parked.get(id) ?? null;
      if (held) enterHints.set(id, held);
      else enterHints.delete(id);
      parked = withoutKey(parked, id);
    }
    return parked === snapshot.parked ? {} : { parked };
  }

  /** Park order, oldest first, trimmed to the cap: past `MAX_PARKED_SURFACES` the
   *  oldest DOM is dropped. Only the DOM is capped — an evicted leaf is still a Door
   *  with live meta in `leafMeta`, so it simply reattaches by reloading. */
  function parkedWith(id: LeafId, rect: Rect | null): ReadonlyMap<string, Rect | null> {
    const p = new Map(snapshot.parked).set(id, rect);
    for (const oldest of p.keys()) {
      if (p.size <= MAX_PARKED_SURFACES) break;
      p.delete(oldest);
    }
    return p;
  }

  /** Where `id` sits under the last reported geometry, or null if it has none yet.
   *  Walks the root→leaf path only, rather than laying out the whole tree to keep
   *  one rect. Peer of `neighborOf` / `autoEdgeFor`. */
  function leafRect(id: LeafId): Rect | null {
    if (!geometry) return null;
    const path = findLeafPath(snapshot.tree, id);
    return path ? nodeRectAtPath(snapshot.tree, geometry.rect, geometry.opts, path) : null;
  }

  /** The shared body of `removeLeaf` / `doorLeaf`: one core `remove`, differing only
   *  in whether the leaf's meta is destroyed with it or retained because the leaf
   *  lives on as a Door. */
  function detachLeaf(
    id: LeafId,
    keepMeta: boolean,
    park: boolean,
  ): { ok: boolean; token: RestoreToken | null } {
    const r = remove(snapshot.tree, id);
    if (!r.ok) return { ok: false, token: null };
    let leafMeta = snapshot.leafMeta;
    if (!keepMeta) leafMeta = withoutKey(leafMeta, id);
    // `zoomedId` always names a leaf in the tree (a store invariant): clear it when
    // the leaf it named departs.
    commit({
      tree: r.tree,
      leafMeta,
      ...(park && leafMeta.has(id) ? { parked: parkedWith(id, leafRect(id)) } : {}),
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
      // `meta` carries the incoming Wall whole: the tree's leaves AND any Doors seeded
      // beside them (hydration passes both). Parked Surfaces outlive it — Workspace
      // switching parks the outgoing Wall and then seeds the incoming one, so dropping
      // their meta here would discard exactly what the switch preserved, and would
      // strand DOM the store no longer knows anything about. Seeded ids win.
      //
      // Unparking is keyed off the TREE, not off `meta`: a parked id handed in only as
      // a Door row is still a Door, and must keep both its DOM and its held rect.
      const next = new Map<string, LeafMeta>();
      for (const id of snapshot.parked.keys()) {
        const held = snapshot.leafMeta.get(id);
        if (held) next.set(id, held);
      }
      for (const [id, m] of meta) next.set(id, m);
      commit({ tree, leafMeta: next, ...admit(leaves(tree)), zoomedId: null });
    },

    addLeaf(id, meta, position) {
      const tree = snapshot.tree;

      // Empty tree: the new leaf becomes the root (there is no core op for
      // inserting into an empty tree — the Wall seeds it here).
      if (tree.root === null) {
        const m = cloneMeta();
        m.set(id, meta);
        commit({ tree: leafTree(id), leafMeta: m, ...admit([id]) });
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
      commit({ tree: r.tree, leafMeta: m, ...admit([id]) });
      return { ok: true };
    },

    removeLeaf: (id) => detachLeaf(id, false, false),

    doorLeaf: (id, opts) => detachLeaf(id, true, opts?.park === true),

    addDoor(id, meta) {
      // One check covers both incoherent cases, because `leafMeta` spans panes and
      // Doors alike: a known id is either already placed in the tree or already a
      // Door whose live state must not be clobbered.
      if (snapshot.leafMeta.has(id)) return;
      commit({ leafMeta: new Map(snapshot.leafMeta).set(id, meta) });
    },

    forgetLeaf(id) {
      if (findLeafPath(snapshot.tree, id) !== null) return; // in the tree — not a Door
      const leafMeta = withoutKey(snapshot.leafMeta, id);
      const parked = withoutKey(snapshot.parked, id);
      if (leafMeta === snapshot.leafMeta && parked === snapshot.parked) return;
      // Nothing will re-admit this id, so drop any hint queued for it too.
      enterHints.delete(id);
      commit({ leafMeta, parked });
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
        ...admit([newId]),
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
      commit({ tree: r.tree, leafMeta: m, ...admit([token.leafId]) });
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
      commit({ tree: r.tree, leafMeta: m, ...admit([id]) });
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
      const cur = snapshot.leafMeta.get(id);
      if (!cur || cur.title === title) return;
      commit({ leafMeta: new Map(snapshot.leafMeta).set(id, { ...cur, title }) });
    },

    updateParams(id, patch) {
      const cur = snapshot.leafMeta.get(id);
      if (!cur) return;
      const params = { ...(cur.params ?? {}), ...patch };
      commit({ leafMeta: new Map(snapshot.leafMeta).set(id, { ...cur, params }) });
    },

    setMeta(id, meta) {
      if (!snapshot.leafMeta.has(id)) return;
      commit({ leafMeta: new Map(snapshot.leafMeta).set(id, meta) });
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
