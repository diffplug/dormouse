import { useContext, useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react';
import {
  DOOR_SELECTION_BORDER_RADIUS,
  TERMINAL_SELECTION_BORDER_RADIUS,
} from '../design';
import { useFocusRingColor } from '../../lib/themes/use-focus-ring-color';
import { resolvePaneElement } from '../../lib/spatial-nav';
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

export function WorkspaceSelectionOverlay({ lathStore, subscribeLathFrames, selectedId, selectedType, mode }: {
  /** The Lath store — the overlay re-measures on every commit (`revision` via
   *  `useSyncExternalStore`), so the ring tracks leaves as they move / resize / restore. */
  lathStore: LathOverlayStore;
  /** The animator's per-frame subscribe (LathHost pumps it). The ring re-measures the
   *  moving leaf each frame and drops its own CSS transition (which would otherwise lag
   *  the streamed rects by ~150ms). Optional-null for tests. */
  subscribeLathFrames?: ((cb: (settled: boolean) => void) => () => void) | null;
  selectedId: string | null;
  selectedType: WallSelectionKind;
  mode: WallMode;
}) {
  const { elements: paneElements, version: paneVersion } = useContext(PaneElementsContext);
  const { elements: doorElements, version: doorVersion } = useContext(DoorElementsContext);
  const selectionColor = useFocusRingColor();
  const windowFocused = useContext(WindowFocusedContext);
  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  // True while the animator streams frames — the ring's own transition is dropped so
  // it tracks the streamed rects exactly instead of chasing them ~150ms behind.
  const [animating, setAnimating] = useState(false);
  const isDoor = selectedType === 'door';

  // Re-run the measuring effect after each Lath commit. Runs post-render, so
  // `getBoundingClientRect` sees the repositioned leaf divs.
  const lathRevision = useSyncExternalStore(lathStore.subscribe, () => lathStore.getSnapshot().revision);

  useEffect(() => {
    if (!selectedId) {
      setRect(null);
      return;
    }

    const INFLATE = 3;

    const update = () => {
      const targetEl = selectedType === 'door'
        ? doorElements.get(selectedId)
        : resolvePaneElement(paneElements.get(selectedId));
      if (!targetEl) return;

      const targetRect = targetEl.getBoundingClientRect();
      const inflate = selectedType === 'door' ? 0 : INFLATE;
      const next = {
        top: targetRect.top - inflate,
        left: targetRect.left - inflate,
        width: targetRect.width + inflate * 2,
        height: targetRect.height + inflate * 2,
      };
      // Bail on an unchanged rect (returning the same identity) so a per-frame animator
      // tick on a stationary selected ring doesn't re-render or force a re-layout.
      setRect((prev) =>
        prev && prev.top === next.top && prev.left === next.left && prev.width === next.width && prev.height === next.height
          ? prev
          : next,
      );
    };

    update();

    const ro = new ResizeObserver(update);
    const panelEl = resolvePaneElement(paneElements.get(selectedId));
    if (panelEl) ro.observe(panelEl);
    const doorEl = doorElements.get(selectedId);
    if (doorEl) ro.observe(doorEl);

    // Re-measures ride the `lathRevision` effect dependency (the store has no
    // DOM-layout event) and, while an animation runs, the animator's per-frame signal
    // (the leaf divs carry the interpolated inline styles, so DOM measurement tracks
    // the tween frame-accurately).
    const unsubFrames = subscribeLathFrames?.((settled) => {
      update();
      setAnimating(!settled);
    });

    return () => { ro.disconnect(); unsubFrames?.(); };
  }, [subscribeLathFrames, lathRevision, selectedId, selectedType, paneVersion, doorVersion, paneElements, doorElements]);

  if (!rect || !selectedId) return null;

  const style: CSSProperties = {
    position: 'fixed',
    pointerEvents: 'none',
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
    zIndex: 50,
    transition: animating ? 'none' : 'top 150ms, left 150ms, width 150ms, height 150ms, filter 200ms',
    filter: windowFocused ? undefined : 'saturate(0.3)',
  };

  if (mode === 'passthrough') {
    style.borderRadius = isDoor ? DOOR_SELECTION_BORDER_RADIUS : TERMINAL_SELECTION_BORDER_RADIUS;
    style.border = `1px solid ${selectionColor}`;
    return <div style={style} />;
  }

  return (
    <div style={style}>
      <MarchingAntsRect
        width={rect.width}
        height={rect.height}
        isDoor={isDoor}
        color={selectionColor}
        paused={!windowFocused}
      />
    </div>
  );
}
