// LathHost — the HTML adapter for Lath (docs/specs/tiling-engine.md → "Adapters;
// the HTML adapter (LathHost)"). The only non-headless piece of the engine: it
// subscribes to the store, runs the pure `layout`/`sashes` per render, and paints
// one stable absolutely-positioned div per leaf.
//
// Contracts it upholds (deviating from any of these needs a flagged reason):
//   - One div per leaf, keyed by id, rendered in a STABLE DOM order (sorted by id,
//     NOT tree order). React must never reorder keyed siblings, because moving an
//     <iframe>'s ancestor in the DOM reloads it. Position is purely geometric
//     (inline left/top/width/height); nothing is ever re-parented.
//   - Layout is a pure function of the tree + container rect, recomputed each
//     render. During a sash drag a local preview tree (core `resize` on the
//     drag-start tree with the cumulative delta) takes precedence; the store
//     commits only on pointerup via `onCommitResize`.
//   - The binding never calls `.focus()` and emits no activation events. Gestures
//     surface as proposals (`onCommitResize`, `onLeafFocused`); the Wall owns
//     selection/focus policy.

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { type LathTree, type Rect, leaves } from '../../lib/lath/model';
import { layout, sashes } from '../../lib/lath/layout';
import { LATH_LAYER_DYING, LATH_LAYER_ELEVATED } from '../../lib/lath/animator';
import { type DropTarget, resize } from '../../lib/lath/ops';
import { useFocusRingColor } from '../../lib/themes/use-focus-ring-color';
import { PANE_HEADER_HEIGHT_PX, TERMINAL_SELECTION_BORDER_RADIUS } from '../design';
import type { PaneProps } from './pane-props';
import { type LeafMeta, LATH_LAYOUT_OPTS } from './lath-wall-store';
import { nowMs, type LathWallEngine } from './lath-wall-engine';
import { type DragController, createDragController } from './lath-drag-controller';
import { TerminalPanel } from './TerminalPanel';
import { BrowserPanel } from './BrowserPanel';
import { TerminalPaneHeader } from './TerminalPaneHeader';
import { SurfacePaneHeader } from './SurfacePaneHeader';

/** Widened pointer target over each (thin) sash band, in px. */
const SASH_HIT = 8;
/** Leaf stacking bands (mapped from the animator's discrete `Frame.layer`). Tiled
 *  survivors sit at 0; a dying leaf fades above them (and above the z-30 sashes);
 *  the zoomed leaf is highest. */
const Z_TILED = 0;
const Z_DYING = 35;
const Z_ZOOMED = 40;
/** The drop-preview overlay floats above every tiled/dying leaf (a drag can't start
 *  while a leaf is zoomed, so it never competes with `Z_ZOOMED`). */
const Z_PREVIEW = 45;
/** Reveal half a pane header of tiled layout around an elevated zoomed pane. */
export const LATH_ZOOM_MARGIN = PANE_HEADER_HEIGHT_PX / 2;
/** Soft app-chrome halo separates the elevated pane from tiled content below. */
export const LATH_ZOOM_SHADOW = '0 0 5px 5px var(--color-app-bg)';

const PANE_HEADER_STYLE: CSSProperties = {
  flex: `0 0 ${PANE_HEADER_HEIGHT_PX}px`,
  height: PANE_HEADER_HEIGHT_PX,
};

function zoomRect(rect: Rect): Rect {
  const inset = Math.min(LATH_ZOOM_MARGIN, rect.width / 2, rect.height / 2);
  return {
    x: rect.x + inset,
    y: rect.y + inset,
    width: Math.max(0, rect.width - inset * 2),
    height: Math.max(0, rect.height - inset * 2),
  };
}

function zIndexForLayer(layer: number): number {
  if (layer >= LATH_LAYER_ELEVATED) return Z_ZOOMED;
  if (layer >= LATH_LAYER_DYING) return Z_DYING;
  return Z_TILED;
}

/** Apply presentation-only zoom without touching the split tree beneath it. */
function presentationTargets(tree: LathTree, rect: Rect, zoomedId: string | null) {
  const targets = layout(tree, rect, LATH_LAYOUT_OPTS);
  const layers = new Map<string, number>();
  if (zoomedId && targets.has(zoomedId)) {
    targets.set(zoomedId, zoomRect(rect));
    layers.set(zoomedId, LATH_LAYER_ELEVATED);
  }
  return { targets, layers };
}

/** Test seam: swap the resolved body/tab components (keyed by component name) so
 *  jsdom tests never mount the real TerminalPane/xterm. */
export type LathComponentsOverride = {
  bodies?: Record<string, ComponentType<PaneProps>>;
  tabs?: Record<string, ComponentType<PaneProps>>;
};

// Body components keyed by `leafMeta.component`; `surface` headers to
// SurfacePaneHeader. Every browser surface resolves to the unified BrowserPanel.
const BODY_COMPONENTS: Record<string, ComponentType<PaneProps>> = {
  terminal: TerminalPanel,
  browser: BrowserPanel,
};
const TAB_COMPONENTS: Record<string, ComponentType<PaneProps>> = {
  terminal: TerminalPaneHeader,
  surface: SurfacePaneHeader,
};

type DragState = {
  splitPath: number[];
  boundary: number;
  /** `'row'` split → the boundary is a vertical divider (col-resize). */
  dir: 'row' | 'col';
  startX: number;
  startY: number;
  /** The tree at drag start; every preview frame re-runs `resize` from it. */
  tree: LathTree;
  delta: number;
};

/** Stable per-id callbacks handed to each `LathLeaf`, cached so the memoized leaf
 *  never re-renders just because a parent commit minted a fresh closure. */
type LeafCallbacks = {
  registerEl: (el: HTMLDivElement | null) => void;
  onHeaderPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
};

/** A leaf's content: the header band atop a filling body. Memoized on its content
 *  identity (id / meta / resolved components / the stable header-press handler), so a
 *  geometry-only frame — a sash-drag preview or a resize commit re-renders the
 *  positioned wrapper — never re-renders the header or body. Returned as a fragment so
 *  the header/body stay direct flex children of `.lath-leaf`. A mounted leaf is always
 *  engine-visible, so the pane props carry no visibility flag (docs/specs/
 *  tiling-engine.md → "Pane props contract"). */
const LathLeafContent = memo(function LathLeafContent({
  id,
  meta,
  Body,
  Tab,
  onHeaderPointerDown,
}: {
  id: string;
  meta: LeafMeta | undefined;
  Body: ComponentType<PaneProps> | undefined;
  Tab: ComponentType<PaneProps> | undefined;
  /** Header-press → maybe a pane drag (threshold-gated in the drag controller). Stable. */
  onHeaderPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const paneProps: PaneProps = { id, title: meta?.title, params: meta?.params };
  return (
    <>
      <div className="lath-leaf-header" style={PANE_HEADER_STYLE} onPointerDown={onHeaderPointerDown}>
        {Tab ? <Tab {...paneProps} /> : null}
      </div>
      <div className="lath-leaf-body">{Body ? <Body {...paneProps} /> : null}</div>
    </>
  );
});

/** One leaf div: the positioned wrapper (geometry only), wrapping the memoized
 *  `LathLeafContent`. Memoized so a store commit or a drag frame only re-renders the
 *  wrappers whose props actually changed. React writes the *target* geometry; while an
 *  animation is in flight LathHost imperatively overrides left/top/width/height/opacity
 *  on the registered div, so a re-render here can't snap a mid-tween leaf back to its
 *  resting rect. Inline styles carry ONLY dynamic values; the rest is `.lath-leaf` CSS. */
const LathLeaf = memo(function LathLeaf({
  id,
  meta,
  Body,
  Tab,
  left,
  top,
  width,
  height,
  zIndex,
  hidden,
  registerEl,
  onHeaderPointerDown,
  onLeafFocused,
}: {
  id: string;
  meta: LeafMeta | undefined;
  Body: ComponentType<PaneProps> | undefined;
  Tab: ComponentType<PaneProps> | undefined;
  left: number;
  top: number;
  width: number;
  height: number;
  zIndex: number;
  /** A leaf with no frame (not laid out and not zoomed) hides rather than tiling. */
  hidden: boolean;
  registerEl: (el: HTMLDivElement | null) => void;
  /** Header-press → maybe a pane drag (threshold-gated in the drag controller). Stable. */
  onHeaderPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onLeafFocused?: (id: string) => void;
}) {
  const style: CSSProperties = hidden ? { display: 'none' } : { left, top, width, height, zIndex };
  return (
    <div
      data-lath-leaf={id}
      className="lath-leaf"
      style={style}
      ref={registerEl}
      onFocusCapture={() => onLeafFocused?.(id)}
    >
      <LathLeafContent id={id} meta={meta} Body={Body} Tab={Tab} onHeaderPointerDown={onHeaderPointerDown} />
    </div>
  );
});

export function LathHost({
  lath,
  onCommitResize,
  onLeafFocused,
  onDragStart,
  onProposeMove,
  onProposeMinimize,
  externalDrag,
  onExternalDrop,
  componentsOverride,
}: {
  /** The Wall's engine handle: LathHost reads `lath.store`, drives `lath.animator`,
   *  drains `lath.store.consumeEnterHints`, and pumps `lath.notifyFrames`. */
  lath: LathWallEngine;
  /** Wall commits the resize (as an op proposal) once the drag ends. */
  onCommitResize: (splitPath: number[], boundary: number, deltaPx: number) => void;
  /** focusin inside a leaf's subtree (embed self-focus adoption, acceptance row 8). */
  onLeafFocused?: (id: string) => void;
  /** A pane drag crossed its threshold — the Wall applies its selection policy. */
  onDragStart?: (id: string) => void;
  /** Drop of an internal pane drag onto a hit-tested target (the Wall commits `move`). */
  onProposeMove?: (id: string, target: DropTarget) => void;
  /** Drop of an internal pane drag onto the baseboard zone (the Wall minimizes it). */
  onProposeMinimize?: (id: string) => void;
  /** When set, a Door press began in the baseboard: LathHost starts an INACTIVE
   *  external drag from `{startX, startY}`, applies its own threshold, and once active
   *  hit-tests with `dragged: null` (no ghost — the chip stays in the baseboard) and
   *  reports the drop. A sub-threshold release reports `null` so the Wall clears the
   *  transient state and the Door's own click-reattach stands. */
  externalDrag?: { id: string; startX: number; startY: number } | null;
  /** Drop of an external (Door) drag: a hit-tested target, or `null` on cancel / a
   *  release over no candidate — the Wall leaves the Door where it is. */
  onExternalDrop?: (target: DropTarget | null) => void;
  componentsOverride?: LathComponentsOverride;
}) {
  const store = lath.store;
  const animator = lath.animator;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);

  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  // Measure the container and track resizes. `getBoundingClientRect` (not
  // `entry.contentRect`) so the measurement is trivially stubbable in jsdom.
  // Reporting geometry from the measurement itself — not a passive effect reading
  // the rendered `size` — is load-bearing: this runs in the layout phase with the
  // real laid-out rect, so it is set before the Wall's seed passive effect reads it
  // (`autoEdge`). A lagging passive report left geometry at the initial 0×0 on
  // mount, so the seed's aspect heuristic saw a square and stacked every pane
  // vertically instead of laying them out by aspect.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      store.setLayoutGeometry({ x: 0, y: 0, width: r.width, height: r.height }, LATH_LAYOUT_OPTS);
      setSize((prev) => (prev.width === r.width && prev.height === r.height ? prev : { width: r.width, height: r.height }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [store]);

  const rect = { x: 0, y: 0, width: size.width, height: size.height };
  const rectRef = useRef(rect);
  rectRef.current = rect;

  // The drop-preview overlay is painted in the selection ring's color (translucent
  // fill + solid border), so it reads as "this pane, dropped here".
  const selectionColor = useFocusRingColor();

  // --- Pane / Door drag (docs/specs/tiling-engine.md → "Hierarchical drag and
  // drop"). All pointer-event based (no HTML5 DnD), so it is CDP-testable and never
  // races React's synthetic events. One `DragController` (built once from
  // `lath-drag-controller.ts`) owns the window listeners and is entered two ways: an
  // internal pane drag (a threshold-gated header press) or an external Door drag (the
  // Wall sets `externalDrag`, carrying the press point). Both feed the same core
  // `hitTest` and render one preview overlay. ---

  // Everything the once-built controller reads through: the latest store snapshot + Wall
  // callbacks, re-mirrored each render so it always sees current values.
  const latestRef = useRef({ snapshot, onDragStart, onProposeMove, onProposeMinimize, onExternalDrop });
  latestRef.current = { snapshot, onDragStart, onProposeMove, onProposeMinimize, onExternalDrop };

  // The current preview overlay rect (null → no overlay). The dragged leaf itself is
  // dimmed imperatively; only this rect is React state.
  const [dragPreview, setDragPreview] = useState<Rect | null>(null);
  // Set when a real drag ends so the click the browser synthesizes on pointerup does
  // not re-fire header/door click behavior; cleared by the click suppressor (or a tick).
  const suppressNextClickRef = useRef(false);
  // Stable map of each leaf's live div, written by `registerEl` and driven imperatively
  // by the animator frames + the drag-dim.
  const leafElsRef = useRef(new Map<string, HTMLDivElement>());

  // Sash drag: a local preview tree takes over layout until pointerup.
  const dragRef = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<LathTree | null>(null);
  // Set on the store commit that ends a drag so the animator snaps rather than
  // tweens — the user placed the boundary by hand, and the animator's "from" would
  // otherwise be the pre-drag rects (the preview never touched it). Cleared by the
  // retarget effect that consumes it.
  const snapNextRef = useRef(false);

  // The single pane/Door drag controller, built once (window handlers stay stable for
  // the whole gesture; nothing re-subscribes on a Wall re-render).
  const dragControllerRef = useRef<DragController | null>(null);
  if (dragControllerRef.current === null) {
    dragControllerRef.current = createDragController({
      latestRef,
      containerRef,
      rectRef,
      leafElsRef,
      sashDragRef: dragRef,
      setDragPreview,
      suppressNextClickRef,
    });
  }
  const dragController = dragControllerRef.current;
  // Unmount teardown (the only lifecycle effect the controller needs — it is otherwise
  // driven imperatively).
  useEffect(() => () => dragController.dispose(), [dragController]);

  useEffect(() => {
    if (!dragging) return;
    // Coalesce pointermove: stash the latest cumulative delta and recompute the
    // preview at most once per animation frame (the resize itself is cheap, but a
    // React commit per pointer event is not).
    let rafId: number | null = null;
    const flush = () => {
      rafId = null;
      const d = dragRef.current;
      if (!d) return;
      setPreview(resize(d.tree, d.splitPath, d.boundary, d.delta, rectRef.current, LATH_LAYOUT_OPTS).tree);
    };
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      d.delta = d.dir === 'row' ? e.clientX - d.startX : e.clientY - d.startY;
      if (rafId === null) rafId = requestAnimationFrame(flush);
    };
    const end = (commit: boolean) => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      const d = dragRef.current;
      dragRef.current = null;
      setDragging(false);
      setPreview(null);
      if (commit && d) {
        snapNextRef.current = true; // the resulting resize commit snaps, doesn't tween
        onCommitResize(d.splitPath, d.boundary, d.delta);
      }
    };
    const onUp = () => end(true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') end(false); // cancel: revert the preview, commit nothing
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
    };
  }, [dragging, onCommitResize]);

  const activeTree = preview ?? snapshot.tree;
  const { targets: frames } = presentationTargets(activeTree, rect, snapshot.zoomedId);
  const sashList = sashes(activeTree, rect, LATH_LAYOUT_OPTS);

  // DOM order is sorted-by-id and STABLE across layout changes; z-index (not DOM
  // order) lifts the zoomed leaf, so keyed siblings never reorder. `leaves()`
  // already returns a fresh array, so sort it in place.
  const sortedIds = leaves(snapshot.tree).sort();
  const zoomedId = snapshot.zoomedId;

  // Create-once-per-id callback bundle so the memoized LathLeaf sees a stable
  // `registerEl` identity across commits.
  const leafCallbacksRef = useRef(new Map<string, LeafCallbacks>());
  const leafCallbacks = (id: string): LeafCallbacks => {
    let cb = leafCallbacksRef.current.get(id);
    if (!cb) {
      cb = {
        registerEl: (el) => {
          if (el) {
            leafElsRef.current.set(id, el);
          } else {
            // Leaf unmounted (removed from the tree) — drop both its div and its cached
            // callbacks so the maps don't accumulate dead ids.
            leafElsRef.current.delete(id);
            leafCallbacksRef.current.delete(id);
          }
        },
        onHeaderPointerDown: (e) => {
          // Primary button only; leave header buttons / the rename input alone so a
          // press on them keeps its click behavior (they never start a drag). The
          // header's own onMouseDown (select / passthrough) still runs — a plain
          // click below the threshold is untouched.
          if (e.button !== 0) return;
          const t = e.target as HTMLElement;
          if (t.closest('button, input, textarea, [contenteditable]')) return;
          dragController.beginInternal(id, e.clientX, e.clientY);
        },
      };
      leafCallbacksRef.current.set(id, cb);
    }
    return cb;
  };

  // Mirror the Wall's `externalDrag` (a Door press in the baseboard) into the
  // controller. Keyed on the id so the Wall passing a fresh object each render never
  // re-fires; the press coords are read from the render where the id became non-null.
  const externalDragId = externalDrag?.id ?? null;
  useEffect(() => {
    if (externalDrag) dragController.beginExternal(externalDrag.id, externalDrag.startX, externalDrag.startY);
    else dragController.endExternal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalDragId]);

  // Swallow the one click the browser synthesizes after a real drag (so a drop over a
  // header/button/door does not also fire its click). Capture phase, so React's own
  // bubble-phase onClick never runs.
  useEffect(() => {
    const onClickCapture = (e: MouseEvent): void => {
      if (!suppressNextClickRef.current) return;
      suppressNextClickRef.current = false;
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener('click', onClickCapture, true);
    return () => window.removeEventListener('click', onClickCapture, true);
  }, []);

  // --- Animation: imperatively apply the animator's interpolated frames to the leaf
  // divs (docs/specs/tiling-engine.md → "Animation contract"). React renders the
  // TARGET geometry; these writes override it while a tween/fade is in flight. ---

  const rafRef = useRef<number | null>(null);
  // Holds the latest `step` for the rAF schedule inside `pump`, so `pump` needn't take
  // `step` as a dependency (they reference each other).
  const stepRef = useRef<() => void>(() => {});
  const applyFrames = useCallback(
    (t: number) => {
      const paint = animator.framesAt(t);
      for (const [id, el] of leafElsRef.current) {
        const f = paint.get(id);
        if (!f) continue; // not tracked (e.g. just-removed) — leave React's styles
        el.style.left = `${f.rect.x}px`;
        el.style.top = `${f.rect.y}px`;
        el.style.width = `${f.rect.width}px`;
        el.style.height = `${f.rect.height}px`;
        el.style.opacity = f.opacity >= 1 ? '' : `${f.opacity}`;
        el.style.zIndex = `${zIndexForLayer(f.layer)}`;
        el.style.boxShadow = f.layer >= LATH_LAYER_ELEVATED ? LATH_ZOOM_SHADOW : '';
        // Elevated zoom is interactive; only the animator's dying state makes a
        // pane inert while it fades.
        el.style.pointerEvents = animator.isDying(id) ? 'none' : '';
      }
    },
    [animator],
  );

  // The single tick body and the loop's entry point (from the retarget effects and the
  // markDying wake): paint now — this runs pre-paint when called from a layout effect,
  // so the first frame is correct — tell chrome, and schedule the loop while anything is
  // still moving. Reschedules only when no frame is already pending.
  const pump = useCallback(() => {
    const t = nowMs();
    applyFrames(t);
    const settled = animator.settledAt(t);
    lath.notifyFrames(settled);
    if (!settled && rafRef.current === null) rafRef.current = requestAnimationFrame(stepRef.current);
  }, [applyFrames, animator, lath]);

  // The scheduled rAF callback: clear the handle it just consumed, then re-enter `pump`
  // (whose reschedule guard now passes, continuing the loop while still unsettled).
  const step = useCallback(() => {
    rafRef.current = null;
    pump();
  }, [pump]);
  stepRef.current = step;

  // A committed layout or zoom change. Retarget every leaf FROM its current
  // interpolated frame (interruptible); a sash-drag commit snaps instead. Zoom is
  // only presentation geometry + stacking, so the split tree stays unchanged.
  useLayoutEffect(() => {
    const { targets, layers } = presentationTargets(snapshot.tree, rectRef.current, snapshot.zoomedId);
    animator.retarget(targets, nowMs(), lath.store.consumeEnterHints(), { snap: snapNextRef.current, layers });
    snapNextRef.current = false;
    pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.tree, snapshot.zoomedId]);

  // A container resize re-lays out instantly (snap) — tweening every resize frame
  // would lag. Skipped before the first measurement.
  useLayoutEffect(() => {
    if (size.width === 0 && size.height === 0) return;
    const { targets, layers } = presentationTargets(snapshot.tree, rectRef.current, snapshot.zoomedId);
    animator.retarget(targets, nowMs(), undefined, { snap: true, layers });
    pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.width, size.height]);

  // After EVERY React commit, re-assert the animator frames while unsettled — a
  // mid-tween re-render (e.g. a meta/title change) would otherwise snap the div's
  // inline styles back to the resting target. Cheap: bails the instant we're settled.
  useLayoutEffect(() => {
    if (!animator.settledAt(nowMs())) pump();
  });

  // Wake the tick loop when the animator becomes busy WITHOUT a store commit —
  // `markDying` starts a fade but does not touch the tree, so no retarget effect fires.
  useEffect(() => lath.subscribeWake(pump), [lath, pump]);

  // Stop the loop on unmount.
  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  const resolveBody = (component: string): ComponentType<PaneProps> | undefined =>
    componentsOverride?.bodies?.[component] ?? BODY_COMPONENTS[component];
  const resolveTab = (tabComponent: string): ComponentType<PaneProps> | undefined =>
    componentsOverride?.tabs?.[tabComponent] ?? TAB_COMPONENTS[tabComponent];

  return (
    <div ref={containerRef} className="lath-host">
      {sortedIds.map((id) => {
        const meta = snapshot.leafMeta.get(id);
        const f = frames.get(id);
        // Geometry passed as primitives so the memoized leaf can shallow-compare.
        // Zoomed → inset wall rect on top; laid-out → its frame at z 0; neither → hidden.
        const cb = leafCallbacks(id);
        const geom = f
          ? {
              left: f.x,
              top: f.y,
              width: f.width,
              height: f.height,
              zIndex: zoomedId === id ? Z_ZOOMED : Z_TILED,
              hidden: false,
            }
          : { left: 0, top: 0, width: 0, height: 0, zIndex: Z_TILED, hidden: true };
        return (
          <LathLeaf
            key={id}
            id={id}
            meta={meta}
            Body={meta ? resolveBody(meta.component) : undefined}
            Tab={meta ? resolveTab(meta.tabComponent) : undefined}
            {...geom}
            registerEl={cb.registerEl}
            onHeaderPointerDown={cb.onHeaderPointerDown}
            onLeafFocused={onLeafFocused}
          />
        );
      })}

      {sashList.map((sash) => {
        const vertical = sash.dir === 'row'; // a 'row' split's boundary is a vertical divider
        // Inline carries ONLY geometry + cursor; position/z-index/touch-action are
        // the `.lath-sash` CSS (z-index 30 sits above tiled leaves at z 0 and below
        // the zoomed leaf at z 40, which hides them).
        const style: CSSProperties = vertical
          ? {
              left: sash.rect.x - (SASH_HIT - sash.rect.width) / 2,
              top: sash.rect.y,
              width: SASH_HIT,
              height: sash.rect.height,
              cursor: 'col-resize',
            }
          : {
              left: sash.rect.x,
              top: sash.rect.y - (SASH_HIT - sash.rect.height) / 2,
              width: sash.rect.width,
              height: SASH_HIT,
              cursor: 'row-resize',
            };
        return (
          <div
            key={`sash-${sash.splitPath.join('.')}-${sash.boundary}`}
            data-lath-sash={`${sash.splitPath.join('.')}-${sash.boundary}`}
            className="lath-sash"
            style={style}
            onPointerDown={(e) => {
              if (dragController.hasDrag()) return; // a pane drag has the pointer
              e.preventDefault();
              (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
              dragRef.current = {
                splitPath: sash.splitPath,
                boundary: sash.boundary,
                dir: sash.dir,
                startX: e.clientX,
                startY: e.clientY,
                tree: snapshot.tree,
                delta: 0,
              };
              setDragging(true);
              setPreview(snapshot.tree);
            }}
          />
        );
      })}

      {/* Drop-preview overlay: the exact rect the current candidate would commit to,
          painted in the selection color (translucent fill + solid border). */}
      {dragPreview && (
        <div
          data-lath-drop-preview=""
          className="lath-drop-preview"
          style={{
            left: dragPreview.x,
            top: dragPreview.y,
            width: dragPreview.width,
            height: dragPreview.height,
            zIndex: Z_PREVIEW,
            border: `1px solid ${selectionColor}`,
            borderRadius: TERMINAL_SELECTION_BORDER_RADIUS,
            backgroundColor: `color-mix(in srgb, ${selectionColor} 22%, transparent)`,
          }}
        />
      )}
    </div>
  );
}
