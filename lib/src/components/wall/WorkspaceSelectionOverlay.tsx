import { useContext, useEffect, useState, useSyncExternalStore, type CSSProperties, type RefObject } from 'react';
import type { DockviewApi } from 'dockview-react';
import {
  DOOR_SELECTION_BORDER_RADIUS,
  TERMINAL_SELECTION_BORDER_RADIUS,
} from '../design';
import { useFocusRingColor } from '../../lib/themes/use-focus-ring-color';
import { resolvePaneGroupElement } from '../../lib/spatial-nav';
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

const NOOP_SUBSCRIBE = (): (() => void) => () => {};
const NOOP_REVISION = (): number => 0;

export function WorkspaceSelectionOverlay({ apiRef, lathStore, subscribeLathFrames, selectedId, selectedType, mode, overlayElRef }: {
  apiRef: RefObject<DockviewApi | null>;
  /** When set (flag on), the overlay re-measures on every Lath commit instead of
   *  `api.onDidLayoutChange`. `apiRef` stays null on this path. */
  lathStore?: LathOverlayStore | null;
  /** The animator's per-frame subscribe (LathHost pumps it). When set (flag on), the
   *  ring re-measures the moving leaf each frame and drops its own CSS transition (which
   *  would otherwise lag the streamed rects by ~150ms). */
  subscribeLathFrames?: ((cb: (settled: boolean) => void) => () => void) | null;
  selectedId: string | null;
  selectedType: WallSelectionKind;
  mode: WallMode;
  overlayElRef?: RefObject<HTMLDivElement | null>;
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

  // Re-run the measuring effect after each Lath commit (0 when flag off). Runs
  // post-render, so `getBoundingClientRect` sees the repositioned leaf divs.
  const lathRevision = useSyncExternalStore(
    lathStore?.subscribe ?? NOOP_SUBSCRIBE,
    lathStore ? () => lathStore.getSnapshot().revision : NOOP_REVISION,
  );

  useEffect(() => {
    const api = apiRef.current;
    if ((!api && !lathStore) || !selectedId) {
      setRect(null);
      return;
    }

    const INFLATE = 3;

    const update = () => {
      const targetEl = selectedType === 'door'
        ? doorElements.get(selectedId)
        : resolvePaneGroupElement(api, selectedId, paneElements);
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
    const panelEl = resolvePaneGroupElement(api, selectedId, paneElements);
    if (panelEl) ro.observe(panelEl);
    const doorEl = doorElements.get(selectedId);
    if (doorEl) ro.observe(doorEl);

    // dockview drives re-measures via layout events; Lath drives them via the
    // `lathRevision` effect dependency (the store has no DOM-layout event) and, while
    // an animation runs, via the animator's per-frame signal (the leaf divs carry the
    // interpolated inline styles, so DOM measurement tracks the tween frame-accurately).
    const d = api?.onDidLayoutChange(update);
    const unsubFrames = subscribeLathFrames?.((settled) => {
      update();
      setAnimating(!settled);
    });

    return () => { ro.disconnect(); d?.dispose(); unsubFrames?.(); };
  }, [apiRef, lathStore, subscribeLathFrames, lathRevision, selectedId, selectedType, paneVersion, doorVersion, paneElements, doorElements]);

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
    return <div ref={overlayElRef} style={style} />;
  }

  return (
    <div ref={overlayElRef} style={style}>
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
