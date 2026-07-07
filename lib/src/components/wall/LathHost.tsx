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
//
// Inert: nothing imports this yet.

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type CSSProperties,
} from 'react';
import { type LathNode, type LathTree, leaves, nodeAtPath } from '../../lib/lath/model';
import { type LayoutOpts, layout, sashes } from '../../lib/lath/layout';
import { resize } from '../../lib/lath/ops';
import type { PaneProps } from './pane-props';
import type { LathWallStore } from './lath-wall-store';
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
/** Zoomed leaf and dragging leaves render above the tiled leaves. */
const Z_TILED = 0;
const Z_ZOOMED = 40;

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

export function LathHost({
  store,
  onCommitResize,
  onLeafFocused,
  componentsOverride,
}: {
  store: LathWallStore;
  /** Wall commits the resize (as an op proposal) once the drag ends. */
  onCommitResize: (splitPath: number[], boundary: number, deltaPx: number) => void;
  /** focusin inside a leaf's subtree (embed self-focus adoption, acceptance row 8). */
  onLeafFocused?: (id: string) => void;
  componentsOverride?: LathComponentsOverride;
}) {
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

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const delta = d.dir === 'row' ? e.clientX - d.startX : e.clientY - d.startY;
      d.delta = delta;
      setPreview(resize(d.tree, d.splitPath, d.boundary, delta, rectRef.current, LATH_LAYOUT_OPTS).tree);
    };
    const end = (commit: boolean) => {
      const d = dragRef.current;
      dragRef.current = null;
      setDragging(false);
      setPreview(null);
      if (commit && d) onCommitResize(d.splitPath, d.boundary, d.delta);
    };
    const onUp = () => end(true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') end(false); // cancel: revert the preview, commit nothing
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
    };
  }, [dragging, onCommitResize]);

  const activeTree = preview ?? snapshot.tree;
  const frames = layout(activeTree, rect, LATH_LAYOUT_OPTS);
  const sashList = sashes(activeTree, rect, LATH_LAYOUT_OPTS);

  // DOM order is sorted-by-id and STABLE across layout changes; z-index (not DOM
  // order) lifts the zoomed leaf, so keyed siblings never reorder.
  const sortedIds = [...leaves(snapshot.tree)].sort();
  const zoomedId = snapshot.zoomedId;

  const leafElsRef = useRef(new Map<string, HTMLDivElement>());

  const resolveBody = (component: string): ComponentType<PaneProps> | undefined =>
    componentsOverride?.bodies?.[component] ?? BODY_COMPONENTS[component];
  const resolveTab = (tabComponent: string): ComponentType<PaneProps> | undefined =>
    componentsOverride?.tabs?.[tabComponent] ?? TAB_COMPONENTS[tabComponent];

  return (
    <div
      ref={containerRef}
      className="lath-host"
      style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, overflow: 'hidden' }}
    >
      {sortedIds.map((id) => {
        const meta = snapshot.leafMeta.get(id);
        const f = frames.get(id);
        const isZoomed = zoomedId === id;
        // Absolute + flex column so the header sits atop a filling body; geometry
        // (left/top/width/height) comes straight from the pure `layout`.
        const base: CSSProperties = { position: 'absolute', display: 'flex', flexDirection: 'column', overflow: 'hidden' };
        const style: CSSProperties = isZoomed
          ? { ...base, left: 0, top: 0, width: rect.width, height: rect.height, zIndex: Z_ZOOMED }
          : f
            ? { ...base, left: f.x, top: f.y, width: f.width, height: f.height, zIndex: Z_TILED }
            : { ...base, display: 'none' };

        const Body = meta ? resolveBody(meta.component) : undefined;
        const Tab = meta ? resolveTab(meta.tabComponent) : undefined;
        const paneProps: PaneProps = {
          id,
          title: meta?.title,
          params: meta?.params,
          // Under Lath a mounted leaf is always engine-visible (no active-tab gating).
          panelVisible: true,
          getAnimEl: () => leafElsRef.current.get(id) ?? null,
        };

        return (
          <div
            key={id}
            data-lath-leaf={id}
            className="lath-leaf"
            style={style}
            ref={(el) => {
              if (el) leafElsRef.current.set(id, el);
              else leafElsRef.current.delete(id);
            }}
            onFocusCapture={() => onLeafFocused?.(id)}
          >
            <div className="lath-leaf-header" style={{ flex: 'none' }}>{Tab ? <Tab {...paneProps} /> : null}</div>
            <div className="lath-leaf-body" style={{ flex: 1, minHeight: 0, position: 'relative' }}>{Body ? <Body {...paneProps} /> : null}</div>
          </div>
        );
      })}

      {sashList.map((sash) => {
        const node = nodeAtPath(activeTree, sash.splitPath);
        const dir: 'row' | 'col' = node && node.kind === 'split' ? (node as Extract<LathNode, { kind: 'split' }>).dir : 'row';
        const vertical = dir === 'row'; // vertical divider between left/right children
        // No zIndex: sashes render after the tiled leaves in DOM order (so they sit
        // over the gap band) but below the zoomed leaf (z=40), which hides them.
        const style: CSSProperties = vertical
          ? {
              position: 'absolute',
              left: sash.rect.x - (SASH_HIT - sash.rect.width) / 2,
              top: sash.rect.y,
              width: SASH_HIT,
              height: sash.rect.height,
              cursor: 'col-resize',
            }
          : {
              position: 'absolute',
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
                dir,
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
