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
} from 'react';
import { type LathTree, leaves } from '../../lib/lath/model';
import { type LayoutOpts, layout, sashes } from '../../lib/lath/layout';
import { resize } from '../../lib/lath/ops';
import type { PaneProps } from './pane-props';
import type { LeafMeta } from './lath-wall-store';
import type { LathWallEngine } from './lath-wall-engine';
import { TerminalPanel } from './TerminalPanel';
import { BrowserPanel } from './BrowserPanel';
import { TerminalPaneHeader } from './TerminalPaneHeader';
import { SurfacePaneHeader } from './SurfacePaneHeader';

/** The geometry LathHost renders with. `gap: 6` matches today's `dormouseTheme.gap`;
 *  `minLeaf` ≈ dockview's default panel minimums. Exported so callers report the
 *  same opts to the store (`setLayoutGeometry`) that the host lays out with. */
export const LATH_LAYOUT_OPTS: LayoutOpts = { gap: 6, minLeaf: { width: 100, height: 60 } };

/** Widened pointer target over each (thin) sash band, in px. */
const SASH_HIT = 8;
/** Leaf stacking bands (mapped from the animator's discrete `Frame.layer`). Tiled
 *  survivors sit at 0; a dying leaf fades above them (and above the z-30 sashes);
 *  the zoomed leaf is highest. */
const Z_TILED = 0;
const Z_DYING = 35;
const Z_ZOOMED = 40;

/** Lath never runs the CSS spawn-animation path (the animator owns entry): the leaf
 *  divs are registered for the animator via `registerEl`, but `getAnimEl` is a no-op
 *  so `usePaneChrome`'s class-based effect stays inert under Lath. */
const NOOP_GET_ANIM_EL = (): HTMLElement | null => null;

/** Wall-clock reader for the animator. Isolated so tests can mock `performance.now`. */
const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Test seam: swap the resolved body/tab components (keyed by component name) so
 *  jsdom tests never mount the real TerminalPane/xterm. */
export type LathComponentsOverride = {
  bodies?: Record<string, ComponentType<PaneProps>>;
  tabs?: Record<string, ComponentType<PaneProps>>;
};

// The same alias tables Wall.tsx uses: legacy `iframe` / `agent-browser` bodies
// resolve to the unified BrowserPanel; `surface` headers to SurfacePaneHeader.
const BODY_COMPONENTS: Record<string, ComponentType<PaneProps>> = {
  terminal: TerminalPanel,
  browser: BrowserPanel,
  iframe: BrowserPanel,
  'agent-browser': BrowserPanel,
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

/** Stable per-id callback handed to each `LathLeaf`, cached so the memoized leaf
 *  never re-renders just because a parent commit minted a fresh closure. */
type LeafCallbacks = {
  registerEl: (el: HTMLDivElement | null) => void;
};

/** One leaf div: header band atop a filling body, positioned purely by the inline
 *  geometry props. Memoized so a store commit or a drag frame only re-renders the
 *  leaves whose props actually changed (geometry / meta / resolved component).
 *  Static presentation (position/flex/overflow) lives in the `.lath-leaf*` CSS. */
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
  onLeafFocused?: (id: string) => void;
}) {
  // React writes the *target* geometry; while an animation is in flight LathHost
  // imperatively overrides left/top/width/height/opacity on the registered div, so a
  // meta re-render here can't snap a mid-tween leaf back to its resting rect. Inline
  // styles carry ONLY dynamic values; the rest is `.lath-leaf` CSS.
  const style: CSSProperties = hidden ? { display: 'none' } : { left, top, width, height, zIndex };
  const paneProps: PaneProps = {
    id,
    title: meta?.title,
    params: meta?.params,
    // Under Lath a mounted leaf is always engine-visible (no active-tab gating).
    panelVisible: true,
    // The animator owns entry; the CSS spawn path is disabled (no-op getAnimEl).
    getAnimEl: NOOP_GET_ANIM_EL,
  };
  return (
    <div
      data-lath-leaf={id}
      className="lath-leaf"
      style={style}
      ref={registerEl}
      onFocusCapture={() => onLeafFocused?.(id)}
    >
      <div className="lath-leaf-header">{Tab ? <Tab {...paneProps} /> : null}</div>
      <div className="lath-leaf-body">{Body ? <Body {...paneProps} /> : null}</div>
    </div>
  );
});

export function LathHost({
  lath,
  onCommitResize,
  onLeafFocused,
  componentsOverride,
}: {
  /** The Wall's engine handle: LathHost reads `lath.store`, drives `lath.animator`,
   *  drains `lath.consumeEnterHints`, and pumps `lath.notifyFrames`. */
  lath: LathWallEngine;
  /** Wall commits the resize (as an op proposal) once the drag ends. */
  onCommitResize: (splitPath: number[], boundary: number, deltaPx: number) => void;
  /** focusin inside a leaf's subtree (embed self-focus adoption, acceptance row 8). */
  onLeafFocused?: (id: string) => void;
  componentsOverride?: LathComponentsOverride;
}) {
  const store = lath.store;
  const animator = lath.animator;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);

  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  // Measure the container and track resizes. `getBoundingClientRect` (not
  // `entry.contentRect`) so the measurement is trivially stubbable in jsdom.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize((prev) => (prev.width === r.width && prev.height === r.height ? prev : { width: r.width, height: r.height }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rect = { x: 0, y: 0, width: size.width, height: size.height };
  const rectRef = useRef(rect);
  rectRef.current = rect;

  // Report the geometry we render with so the store's queries (restore/resize/
  // neighbors/autoEdge) match the screen.
  useEffect(() => {
    store.setLayoutGeometry({ x: 0, y: 0, width: size.width, height: size.height }, LATH_LAYOUT_OPTS);
  }, [store, size.width, size.height]);

  // Sash drag: a local preview tree takes over layout until pointerup.
  const dragRef = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<LathTree | null>(null);
  // Set on the store commit that ends a drag so the animator snaps rather than
  // tweens — the user placed the boundary by hand, and the animator's "from" would
  // otherwise be the pre-drag rects (the preview never touched it). Cleared by the
  // retarget effect that consumes it.
  const snapNextRef = useRef(false);

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
  const frames = layout(activeTree, rect, LATH_LAYOUT_OPTS);
  const sashList = sashes(activeTree, rect, LATH_LAYOUT_OPTS);

  // DOM order is sorted-by-id and STABLE across layout changes; z-index (not DOM
  // order) lifts the zoomed leaf, so keyed siblings never reorder. `leaves()`
  // already returns a fresh array, so sort it in place.
  const sortedIds = leaves(snapshot.tree).sort();
  const zoomedId = snapshot.zoomedId;

  const leafElsRef = useRef(new Map<string, HTMLDivElement>());
  // Create-once-per-id callback bundle so the memoized LathLeaf sees a stable
  // `registerEl` identity across commits.
  const leafCallbacksRef = useRef(new Map<string, LeafCallbacks>());
  const leafCallbacks = (id: string): LeafCallbacks => {
    let cb = leafCallbacksRef.current.get(id);
    if (!cb) {
      cb = {
        registerEl: (el) => {
          if (el) leafElsRef.current.set(id, el);
          else leafElsRef.current.delete(id);
        },
      };
      leafCallbacksRef.current.set(id, cb);
    }
    return cb;
  };

  // --- Animation: imperatively apply the animator's interpolated frames to the leaf
  // divs (docs/specs/tiling-engine.md → "Animation contract"). React renders the
  // TARGET geometry; these writes override it while a tween/fade is in flight. ---

  const rafRef = useRef<number | null>(null);
  // The zoomed leaf is React-driven (full-rect) and never animated, so `applyFrames`
  // skips it. Kept in a ref so the rAF callback always sees the latest.
  const zoomedIdRef = useRef<string | null>(null);
  zoomedIdRef.current = zoomedId;

  const applyFrames = useCallback(
    (t: number) => {
      const paint = animator.framesAt(t);
      const zoomed = zoomedIdRef.current;
      for (const [id, el] of leafElsRef.current) {
        if (id === zoomed) continue; // zoom owns its full-rect geometry
        const f = paint.get(id);
        if (!f) continue; // not tracked (e.g. just-removed) — leave React's styles
        el.style.left = `${f.rect.x}px`;
        el.style.top = `${f.rect.y}px`;
        el.style.width = `${f.rect.width}px`;
        el.style.height = `${f.rect.height}px`;
        el.style.opacity = f.opacity >= 1 ? '' : `${f.opacity}`;
        if (f.layer >= 1) {
          // Dying: fade above the survivors and swallow no pointer events.
          el.style.zIndex = `${Z_DYING}`;
          el.style.pointerEvents = 'none';
        } else {
          el.style.zIndex = `${Z_TILED}`;
          el.style.pointerEvents = '';
        }
      }
    },
    [animator],
  );

  // The rAF tick: paint the current frame, tell chrome, reschedule while unsettled.
  const step = useCallback(() => {
    rafRef.current = null;
    const t = nowMs();
    applyFrames(t);
    const settled = animator.settledAt(t);
    lath.notifyFrames(settled);
    if (!settled) rafRef.current = requestAnimationFrame(step);
  }, [applyFrames, animator, lath]);

  // Entry point (from the retarget effects and the markDying wake): paint now — this
  // runs pre-paint when called from a layout effect, so the first frame is correct —
  // and ensure the loop is scheduled while anything is still moving.
  const pump = useCallback(() => {
    const t = nowMs();
    applyFrames(t);
    const settled = animator.settledAt(t);
    lath.notifyFrames(settled);
    if (!settled && rafRef.current === null) rafRef.current = requestAnimationFrame(step);
  }, [applyFrames, animator, lath, step]);

  // A committed layout change (store commit that alters the tree). Retarget every
  // leaf FROM its current interpolated frame (interruptible); a sash-drag commit
  // snaps instead. Keyed on tree identity so meta/zoom commits never retarget (the
  // other referenced values are stable refs/callbacks).
  useLayoutEffect(() => {
    const targets = layout(snapshot.tree, rectRef.current, LATH_LAYOUT_OPTS);
    animator.retarget(targets, nowMs(), lath.consumeEnterHints(), { snap: snapNextRef.current });
    snapNextRef.current = false;
    pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.tree]);

  // A container resize re-lays out instantly (snap) — tweening every resize frame
  // would lag. Skipped before the first measurement.
  useLayoutEffect(() => {
    if (size.width === 0 && size.height === 0) return;
    const targets = layout(snapshot.tree, { x: 0, y: 0, width: size.width, height: size.height }, LATH_LAYOUT_OPTS);
    animator.retarget(targets, nowMs(), undefined, { snap: true });
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
        const isZoomed = zoomedId === id;
        // Geometry passed as primitives so the memoized leaf can shallow-compare.
        // Zoomed → full rect on top; laid-out → its frame at z 0; neither → hidden.
        const cb = leafCallbacks(id);
        const geom = isZoomed
          ? { left: 0, top: 0, width: rect.width, height: rect.height, zIndex: Z_ZOOMED, hidden: false }
          : f
            ? { left: f.x, top: f.y, width: f.width, height: f.height, zIndex: Z_TILED, hidden: false }
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
    </div>
  );
}
