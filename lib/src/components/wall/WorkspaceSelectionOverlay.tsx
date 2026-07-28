import { useContext, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import {
  FOCUS_MOTION_MS,
  PANE_GUTTER_PX,
  PANE_SELECTION_RING_RADIUS_PX,
  SELECTION_RING_INFLATE_PX,
  TERMINAL_BORDER_RADIUS_PX,
} from '../design';
import { cfg } from '../../cfg';
import { prefersReducedMotion } from '../../lib/ui-geometry';
import {
  retargetRingTween,
  sampleRingTween,
  startRingTween,
  type RingFrame,
  type RingShape,
  type RingTween,
} from '../../lib/rect-tween';
import { useFocusRingColor } from '../../lib/themes/use-focus-ring-color';
import { resolvePaneElement } from './resolve-pane-element';
import type { WallMode, WallSelectionKind } from './wall-types';
import { DoorElementsContext, PaneElementsContext, WindowFocusedContext } from './wall-context';
import { MarchingAntsRect } from './MarchingAntsRect';

/** The subset of the Lath store the overlay needs — a revision that bumps on every
 *  commit, so the ring re-measures as leaves move / resize / restore. Kept
 *  structural so this module doesn't hard-depend on the store. */
export interface LathOverlayStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): { revision: number };
}

/** Concentric-corners rule (design.tsx): the pane ring draws on a rect inflated by
 *  SELECTION_RING_INFLATE_PX, so its edge radius is the pane radius plus that
 *  offset; the door ring draws on the door rect itself and keeps the pane radius,
 *  rounding only the top corners. The `inset` shrinks the marching-ants path so its
 *  stroke centerline stays on the gutter's midline: the pane inset lands the
 *  centerline at PANE_GUTTER_PX / 2 from the pane edge (the same line the 1px
 *  passthrough border sits on); the door ring has no gutter, so it straddles the
 *  door edge (inset = strokeWidth / 2). Radii + inset ride the tween so a pane↔door
 *  selection morphs its shape instead of popping. */
function ringShape(isDoor: boolean): RingShape {
  if (isDoor) {
    const r = TERMINAL_BORDER_RADIUS_PX;
    return { tl: r, tr: r, br: 0, bl: 0, inset: cfg.marchingAnts.strokeWidth / 2 };
  }
  const r = PANE_SELECTION_RING_RADIUS_PX;
  return { tl: r, tr: r, br: r, bl: r, inset: SELECTION_RING_INFLATE_PX - PANE_GUTTER_PX / 2 };
}

function measureFrame(el: HTMLElement, isDoor: boolean): RingFrame {
  const r = el.getBoundingClientRect();
  const inflate = isDoor ? 0 : SELECTION_RING_INFLATE_PX;
  return {
    rect: {
      top: r.top - inflate,
      left: r.left - inflate,
      width: r.width + inflate * 2,
      height: r.height + inflate * 2,
    },
    shape: ringShape(isDoor),
  };
}

function framesEqual(a: RingFrame, b: RingFrame): boolean {
  return (
    a.rect.top === b.rect.top && a.rect.left === b.rect.left
    && a.rect.width === b.rect.width && a.rect.height === b.rect.height
    && a.shape.tl === b.shape.tl && a.shape.tr === b.shape.tr
    && a.shape.br === b.shape.br && a.shape.bl === b.shape.bl
    && a.shape.inset === b.shape.inset
  );
}

export function WorkspaceSelectionOverlay({ lathStore, subscribeLathFrames, selectedId, selectedType, mode }: {
  /** The Lath store — the overlay re-measures on every commit (`revision` via
   *  `useSyncExternalStore`), so the ring tracks leaves as they move / resize / restore. */
  lathStore: LathOverlayStore;
  /** The animator's per-frame subscribe (LathHost pumps it). While the wall streams
   *  frames the ring re-measures the moving leaf each frame; same-identity updates
   *  snap 1:1 so the ring tracks the streamed geometry exactly. Optional-null for tests. */
  subscribeLathFrames?: ((cb: (settled: boolean) => void) => () => void) | null;
  selectedId: string | null;
  selectedType: WallSelectionKind;
  mode: WallMode;
}) {
  const { elements: paneElements, version: paneVersion } = useContext(PaneElementsContext);
  const { elements: doorElements, version: doorVersion } = useContext(DoorElementsContext);
  const selectionColor = useFocusRingColor();
  const windowFocused = useContext(WindowFocusedContext);
  const [displayed, setDisplayed] = useState<RingFrame | null>(null);

  // Refs survive the measuring effect's re-runs (lathRevision / paneVersion /
  // doorVersion): the ring's current on-screen frame (the tween's `from` on an
  // identity change), the identity it belongs to, the live tween, and the pending
  // rAF handle. The tween is a pure function of time (rect-tween.ts); this loop is
  // its only DOM/React driver.
  const displayedFrameRef = useRef<RingFrame | null>(null);
  const displayedIdentityRef = useRef<string | null>(null);
  const tweenRef = useRef<RingTween | null>(null);
  const rafRef = useRef<number | null>(null);

  // Re-run the measuring effect after each Lath commit. Runs post-render, so
  // `getBoundingClientRect` sees the repositioned leaf divs.
  const lathRevision = useSyncExternalStore(lathStore.subscribe, () => lathStore.getSnapshot().revision);

  useEffect(() => {
    const commitDisplayed = (frame: RingFrame) => {
      displayedFrameRef.current = frame;
      setDisplayed((prev) => (prev && framesEqual(prev, frame) ? prev : frame));
    };

    // One `setState` per frame. Samples the live tween at wall-clock `now`, clears
    // the tween when it lands, and self-schedules until then.
    const tick = () => {
      rafRef.current = null;
      const tween = tweenRef.current;
      if (!tween) return;
      const { rect, shape, done } = sampleRingTween(tween, performance.now());
      commitDisplayed({ rect, shape });
      if (done) {
        tweenRef.current = null;
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    const scheduleTick = () => {
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(tick);
    };
    const cancelTick = () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
    const snapTo = (frame: RingFrame, identity: string) => {
      tweenRef.current = null;
      cancelTick();
      displayedIdentityRef.current = identity;
      commitDisplayed(frame);
    };

    if (!selectedId) {
      tweenRef.current = null;
      cancelTick();
      displayedIdentityRef.current = null;
      displayedFrameRef.current = null;
      setDisplayed(null);
      return;
    }

    const isDoor = selectedType === 'door';
    const identity = `${selectedType}:${selectedId}`;

    const update = () => {
      const targetEl = isDoor
        ? doorElements.get(selectedId)
        : resolvePaneElement(paneElements.get(selectedId));
      if (!targetEl) return; // bail-and-hold: the leaf is momentarily absent

      const next = measureFrame(targetEl, isDoor);

      // Snap gate: no layout animation (Chromatic) or reduced motion → the ring
      // settles instantly, mirroring lath-wall-engine.ts's 0-duration path.
      if (!cfg.layout.animate || prefersReducedMotion()) {
        snapTo(next, identity);
        return;
      }
      // Ring appearing (nothing shown yet) → snap; there is no `from` to glide from.
      if (!displayedFrameRef.current || displayedIdentityRef.current === null) {
        snapTo(next, identity);
        return;
      }
      // Selection identity changed → tween from the current on-screen frame; the
      // clock restarts so rapid re-selection stays responsive.
      if (identity !== displayedIdentityRef.current) {
        tweenRef.current = startRingTween(displayedFrameRef.current, next, performance.now(), FOCUS_MOTION_MS);
        displayedIdentityRef.current = identity;
        scheduleTick();
        return;
      }
      // Same identity, tween in flight → retarget its destination (same clock),
      // so the ring converges on a moving target (select-neighbor-during-kill).
      if (tweenRef.current) {
        tweenRef.current = retargetRingTween(tweenRef.current, next);
        scheduleTick();
        return;
      }
      // Same identity, settled → snap 1:1. Sash drags and window resizes track the
      // geometry exactly instead of easing behind it.
      commitDisplayed(next);
    };

    update();

    const ro = new ResizeObserver(update);
    const panelEl = resolvePaneElement(paneElements.get(selectedId));
    if (panelEl) ro.observe(panelEl);
    const doorEl = doorElements.get(selectedId);
    if (doorEl) ro.observe(doorEl);

    // While the wall streams animator frames the leaf divs carry the interpolated
    // inline geometry, so re-measuring each frame tracks the tween frame-accurately.
    const unsubFrames = subscribeLathFrames?.(() => update());

    return () => { ro.disconnect(); unsubFrames?.(); };
    // The rAF loop is intentionally NOT torn down here: it is keyed to the tween
    // (a ref), so a mid-glide re-run of this effect keeps the ring moving. It is
    // cancelled on selection-clear (above), on snap, and on unmount (below).
  }, [subscribeLathFrames, lathRevision, selectedId, selectedType, paneVersion, doorVersion, paneElements, doorElements]);

  // Cancel any in-flight rAF on unmount.
  useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
  }, []);

  if (!displayed || !selectedId) return null;

  const { rect, shape } = displayed;
  const style: CSSProperties = {
    position: 'fixed',
    pointerEvents: 'none',
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
    zIndex: 50,
    // The rect is driven per-frame by the JS tween; only the unfocus-saturate fade
    // rides a CSS transition (D7 — there is no layout transition left to drop).
    transition: `filter ${FOCUS_MOTION_MS}ms`,
    filter: windowFocused ? undefined : 'saturate(0.3)',
  };

  if (mode === 'passthrough') {
    style.borderRadius = `${shape.tl}px ${shape.tr}px ${shape.br}px ${shape.bl}px`;
    style.border = `1px solid ${selectionColor}`;
    return <div style={style} />;
  }

  return (
    <div style={style}>
      <MarchingAntsRect
        width={rect.width}
        height={rect.height}
        tl={shape.tl}
        tr={shape.tr}
        br={shape.br}
        bl={shape.bl}
        inset={shape.inset}
        color={selectionColor}
        paused={!windowFocused}
      />
    </div>
  );
}
