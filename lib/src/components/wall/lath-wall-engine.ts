// The Wall-facing Lath engine handle (docs/specs/tiling-engine.md → "The wall store
// and engine"). The store (`lath-wall-store.ts`) is the state machine + geometry +
// enter hints; the engine layers presentation, vocabulary, and persistence
// conveniences over it — the animator (entry/exit/tween + dying state), the
// pane-list / meta projections, the dor-direction ↔ Edge maps, the leaf-meta
// builders, and the hydration `seed` + `serializeLayout`. Every state op and
// geometry query goes straight to `lath.store.*`; the engine no longer re-exports
// them.
//
// The engine holds NO selection/focus/mode/activation state — those stay in the Wall.

import {
  type Edge,
  type LathTree,
  leafTree,
  leaves,
  validate,
} from '../../lib/lath/model';
import type { Direction } from '../../lib/lath/layout';
import {
  type LathAnimator,
  LATH_EASING,
  LATH_MOTION_MS,
  createAnimator,
} from '../../lib/lath/animator';
import { motionIsInstant } from '../../lib/ui-geometry';
import { UNNAMED_PANEL_TITLE } from '../../lib/terminal-registry';
import type { ResolvedSplitDirection as DorResolvedSplitDirection } from 'dor/commands/types';
import {
  type LathWallSnapshot,
  type LathWallStore,
  type LeafMeta,
  createLathWallStore,
} from './lath-wall-store';
import {
  type LathPersistedLayout,
  isLathPersistedLayout,
  lathLayoutFromStore,
} from '../../lib/lath/persistence';
import type { VisiblePane } from './wall-types';
import type { PersistedDoor } from '../../lib/session-types';

/** Wall-clock reader for the animator (the single definition — LathHost imports it
 *  rather than duplicating one). Kept out of the pure core, which always takes `now`
 *  as an argument; isolated here so tests can mock `performance.now`. */
export const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** dor split direction → Lath edge. `'up'`/`'down'` map to the vertical axis. */
export function edgeForDorDirection(direction: DorResolvedSplitDirection): Edge {
  switch (direction) {
    case 'left':
      return 'left';
    case 'right':
      return 'right';
    case 'up':
      return 'top';
    case 'down':
      return 'bottom';
  }
}

/** Lath edge → dor resolved split direction (for `direction: 'auto'` resolution at
 *  the dor handler). `autoEdge` only ever returns `'right'`/`'bottom'`, but the full
 *  map is exhaustive. */
export function dorDirectionForEdge(edge: Edge): DorResolvedSplitDirection {
  switch (edge) {
    case 'left':
      return 'left';
    case 'right':
      return 'right';
    case 'top':
      return 'up';
    case 'bottom':
      return 'down';
  }
}

/** Keyboard arrow → Lath spatial direction. */
export function directionForArrow(key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'): Direction {
  switch (key) {
    case 'ArrowLeft':
      return 'left';
    case 'ArrowRight':
      return 'right';
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
  }
}

/** Default meta for a freshly-spawned terminal leaf (the Pane-props contract's
 *  read side; live titles still come from the terminal-state stores). */
export function terminalLeafMeta(title: string = UNNAMED_PANEL_TITLE): LeafMeta {
  return { component: 'terminal', tabComponent: 'terminal', title };
}

/** Meta for a browser (iframe / agent-browser) leaf. */
export function browserLeafMeta(title: string, params: Record<string, unknown>): LeafMeta {
  return { component: 'browser', tabComponent: 'surface', title, params };
}

/** Rebuild a leaf's meta from a PERSISTED door row, for hydration only: a restored
 *  session's Doors have no store entry yet, and `seed` puts them back into `leafMeta`
 *  alongside the tree's own leaves. Component/tabComponent default to terminal for a
 *  row that carries neither. Nothing at runtime reads a Door record for meta — the
 *  store owns it (docs/specs/layout.md → "Minimize and reattach"). */
export function leafMetaFromPersistedDoor(item: PersistedDoor): LeafMeta {
  return {
    component: item.component ?? 'terminal',
    tabComponent: item.tabComponent ?? 'terminal',
    title: item.title,
    params: item.params,
  };
}

/** Whether minimizing this leaf should park it rather than remove it: true when the
 *  Surface's state lives in its DOM. Browser Surfaces qualify (an iframe document, a
 *  screencast canvas); terminals do not — the PTY holds their state and the registry
 *  replays it (docs/specs/tiling-engine.md → "Parked leaves"). */
export function shouldParkOnMinimize(meta: LeafMeta): boolean {
  return meta.component === 'browser';
}

export type LathWallEngine = {
  /** The underlying headless store — the state machine + geometry every state op and
   *  query goes through directly (`lath.store.*`), and the reader LathHost + the
   *  persistence subscription subscribe to. */
  store: LathWallStore;

  // --- animation (docs/specs/tiling-engine.md → "Animation") ---
  /** The headless motion core the HTML adapter drives from its rAF loop. Created
   *  with a 0 duration under reduced motion, so the same code path snaps instantly. */
  animator: LathAnimator;
  /** The kill-fade duration (ms) the Wall waits before committing `remove`. Equals
   *  the animator duration (0 under reduced motion). */
  exitMs: number;
  /** Begin a leaf's exit fade (phase 1 of a kill); `shrinkTowardBottomRight` also
   *  collapses it toward its bottom-right corner (the last-pane kill). Idempotent. */
  markDying(id: string, opts?: { shrinkTowardBottomRight?: boolean }): void;
  /** Whether `id` is mid-fade — the Wall's re-entrant-kill guard. */
  isDying(id: string): boolean;
  /** Presentation-frame signal for chrome (the selection ring). LathHost's tick
   *  calls `notifyFrames(settled)`; subscribers re-measure. Returns an unsubscribe. */
  subscribeFrames(cb: (settled: boolean) => void): () => void;
  notifyFrames(settled: boolean): void;
  /** Wake signal for the adapter's tick loop — fired when the animator becomes busy
   *  without a store commit (i.e. `markDying`). Returns an unsubscribe. */
  subscribeWake(cb: () => void): () => void;

  // --- reads / projections over the store ---
  /** Visible leaves in tree pre-order, each with its meta title + params. Parked
   *  leaves are not visible and are not listed. */
  listPanes(): VisiblePane[];
  /** The leaf's metadata, or undefined. Resolves Doored leaves (parked or not) too —
   *  the store is the single authority for a minimized Surface's live title/params,
   *  so this is what every Door reader calls. */
  getMeta(id: string): LeafMeta | undefined;

  // --- persistence ---
  serializeLayout(): LathPersistedLayout;

  /** Hydration: a persisted Lath layout when usable, else a fresh tree from
   *  `initialPaneIds` (or one generated id). Returns the resulting pane ids
   *  (pre-order) and whether the fresh path was taken (so the Wall knows to prime
   *  default-shell opts, mirroring `addTerminalPanel`). */
  seed(
    lathBlob: unknown,
    initialPaneIds: string[] | undefined,
    generatePaneId: () => string,
    /** Persisted Doors restored alongside the tree. Their meta is seeded into the
     *  store in the same commit, because the store — not the Door record — is the
     *  authority for a minimized Surface's title/params from then on. */
    doors?: readonly PersistedDoor[],
  ): { paneIds: string[]; fresh: boolean };
};

export function createLathWallEngine(
  store: LathWallStore = createLathWallStore(),
  opts?: { durationMs?: number },
): LathWallEngine {
  const snapshot = (): LathWallSnapshot => store.getSnapshot();

  // 0 when motion must be instant (reduced motion, or Chromatic's animate=false),
  // so entry/exit/tween all collapse to instant through the very same code path.
  // Tests inject a fixed duration (or 0) via `opts`.
  const durationMs =
    opts?.durationMs ?? (motionIsInstant() ? 0 : LATH_MOTION_MS);
  const animator = createAnimator({ durationMs, easing: LATH_EASING });

  // Presentation-only side state (never in the store snapshot): the frame/wake
  // listener sets. Enter hints live in the store; dying state lives in the animator.
  const frameListeners = new Set<(settled: boolean) => void>();
  const wakeListeners = new Set<() => void>();

  return {
    store,

    animator,
    exitMs: durationMs,
    markDying(id, markOpts) {
      // The animator owns dying state (idempotent per id); wake the tick loop, since
      // a fade starts no store commit and so fires no retarget effect.
      animator.markDying(id, nowMs(), markOpts);
      for (const l of wakeListeners) l();
    },
    isDying: (id) => animator.isDying(id),
    subscribeFrames(cb) {
      frameListeners.add(cb);
      return () => frameListeners.delete(cb);
    },
    notifyFrames(settled) {
      for (const l of frameListeners) l(settled);
    },
    subscribeWake(cb) {
      wakeListeners.add(cb);
      return () => wakeListeners.delete(cb);
    },

    listPanes() {
      const meta = snapshot().leafMeta;
      return store.leafIds().map((id) => {
        const m = meta.get(id);
        return { id, title: m?.title, params: m?.params };
      });
    },
    getMeta: (id) => snapshot().leafMeta.get(id),

    serializeLayout: () => lathLayoutFromStore(snapshot()),

    seed(lathBlob, initialPaneIds, generatePaneId, doors) {
      // Doors ride into `leafMeta` beside the tree's leaves: a restored Door is a
      // detached leaf, and detachment is a tree fact, not a metadata one.
      const doorMeta = (doors ?? []).map(
        (door) => [door.id, leafMetaFromPersistedDoor(door)] as const,
      );

      // 1. A persisted Lath layout (must validate; empty trees fall through so the
      //    Wall always seeds ≥1 pane).
      if (isLathPersistedLayout(lathBlob)) {
        const tree = lathBlob.tree as LathTree;
        if (validate(tree).length === 0 && leaves(tree).length > 0) {
          store.seed(tree, [...Object.entries(lathBlob.leafMeta), ...doorMeta]);
          return { paneIds: store.leafIds(), fresh: false };
        }
      }

      // 2. Fresh tree from the restored session ids (or one generated id), splitting
      //    successive panes via the store's autoEdge (as `addTerminalPanel` does).
      const ids = initialPaneIds && initialPaneIds.length > 0 ? initialPaneIds : [generatePaneId()];
      store.seed(leafTree(ids[0]), [[ids[0], terminalLeafMeta()], ...doorMeta]);
      for (let i = 1; i < ids.length; i++) {
        store.addLeaf(ids[i], terminalLeafMeta(), null);
      }
      return { paneIds: store.leafIds(), fresh: true };
    },
  };
}
