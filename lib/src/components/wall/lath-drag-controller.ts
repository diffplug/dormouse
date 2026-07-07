// The pane / Door drag gesture controller (docs/specs/tiling-engine.md →
// "Hierarchical drag and drop"). Pure imperative pointer machinery with no React
// dependency beyond ref types: LathHost builds exactly one controller per mount and
// drives it from a header press (internal pane drag) or the Wall's `externalDrag`
// mirror (a Door drag entering from the baseboard). Both paths share the threshold
// gate, the per-frame hit-test against the LIVE store tree, wheel depth cycling,
// Escape cancel, and the drop-preview publication; the controller owns the window
// listeners for the whole gesture, so nothing re-subscribes on a Wall re-render.

import type { MutableRefObject, RefObject } from 'react';
import { type Rect, rectKey } from '../../lib/lath/model';
import type { DropTarget } from '../../lib/lath/ops';
import { type DropCandidate, hitTest } from '../../lib/lath/hit-test';
import { type LathWallSnapshot, LATH_LAYOUT_OPTS } from './lath-wall-store';

/** Pointer travel (px) before a header press becomes a pane drag; below it the
 *  header's own click behavior (select / enter passthrough / rename) is untouched. */
const DRAG_THRESHOLD = 5;
/** Opacity applied to the dragged leaf while its drop preview floats elsewhere. */
const DRAG_DIM = '0.6';

/** A live pane / Door drag session. Each frame hit-tests against the *live* store
 *  tree (read fresh, so a background `dor split`/`dor kill` commit mid-drag is
 *  reflected); `depth` indexes the hit-test candidates, cycled by the wheel and reset
 *  when the candidate list changes. */
type PaneDragState = {
  /** The dragged leaf (internal) or the Door being dragged in (external). */
  id: string;
  external: boolean;
  /** Crossed the drag threshold. Both internal and external drags start INACTIVE and
   *  apply the same threshold before activating. */
  active: boolean;
  startX: number;
  startY: number;
  candidates: DropCandidate[];
  depth: number;
  /** Serialized candidate targets — a change resets `depth` to the innermost. */
  candKey: string;
  lastX: number;
  lastY: number;
  rafId: number | null;
};

/** Stable methods for the one pane/Door drag session. Built once per LathHost mount
 *  (a `useRef` factory), so the window handlers keep the same identity for the whole
 *  gesture and nothing re-subscribes on a Wall re-render. */
export type DragController = {
  /** Begin an internal pane drag from a header press. Starts INACTIVE — the threshold
   *  gate runs in `onMove`, so a sub-threshold press keeps its click behavior. */
  beginInternal(id: string, clientX: number, clientY: number): void;
  /** Begin an external Door drag from its baseboard press. Also starts INACTIVE and
   *  applies the same threshold before activating. */
  beginExternal(id: string, startX: number, startY: number): void;
  /** The Wall cleared `externalDrag` (drop handled elsewhere / teardown) — stop any
   *  in-flight external drag cleanly. */
  endExternal(): void;
  /** Whether a pane/Door drag currently owns the pointer (the sash-drag guard). */
  hasDrag(): boolean;
  /** Unmount teardown: detach the window listeners and cancel any pending frame. */
  dispose(): void;
};

/** The mutable prop/snapshot surface the controller reads through, plus the stable
 *  React refs/setters it drives. All identities are stable across renders. */
export type DragControllerDeps = {
  latestRef: MutableRefObject<{
    snapshot: LathWallSnapshot;
    onDragStart?: (id: string) => void;
    onProposeMove?: (id: string, target: DropTarget) => void;
    onProposeMinimize?: (id: string) => void;
    onExternalDrop?: (target: DropTarget | null) => void;
  }>;
  containerRef: RefObject<HTMLDivElement | null>;
  rectRef: MutableRefObject<Rect>;
  leafElsRef: MutableRefObject<Map<string, HTMLDivElement>>;
  /** Sash-drag session — the pane drag never starts while one is live. Read-only
   *  here; the session's shape is LathHost's own concern. */
  sashDragRef: { readonly current: object | null };
  setDragPreview: (rect: Rect | null) => void;
  suppressNextClickRef: MutableRefObject<boolean>;
};

export function createDragController(deps: DragControllerDeps): DragController {
  // The live drag session (mutated in place by the window handlers).
  let drag: PaneDragState | null = null;
  // The last preview rect published to React state (`x,y,w,h`); a frame that lands in
  // the same band skips the redundant setState (and its forced re-layout).
  let lastPreviewKey = '';

  const publishPreview = (rect: Rect | null): void => {
    if (rect === null) {
      if (lastPreviewKey !== '') {
        lastPreviewKey = '';
        deps.setDragPreview(null);
      }
      return;
    }
    const key = rectKey(rect);
    if (key === lastPreviewKey) return;
    lastPreviewKey = key;
    deps.setDragPreview(rect);
  };

  const detach = (): void => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('wheel', onWheel);
    if (drag && drag.rafId !== null) {
      cancelAnimationFrame(drag.rafId);
      drag.rafId = null;
    }
  };

  const attach = (): void => {
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
    // Non-passive: the wheel cycles drop depth instead of scrolling.
    window.addEventListener('wheel', onWheel, { passive: false });
  };

  const runHitTest = (): void => {
    const d = drag;
    if (!d || !d.active) return;
    const containerEl = deps.containerRef.current;
    if (!containerEl) return;
    const cr = containerEl.getBoundingClientRect();
    // An internal drag below the wall is the baseboard minimize zone — no drop
    // candidates (the minimize is decided at `finish` from the pointer position). A Door
    // dropped there just cancels (dragged back down it stays a Door), so external skips it.
    if (!d.external && d.lastY > cr.bottom) {
      d.candidates = [];
      publishPreview(null);
      return;
    }
    const point = { x: d.lastX - cr.left, y: d.lastY - cr.top };
    // Hit-test the LIVE store tree so a background `dor split`/`dor kill` commit
    // mid-drag is reflected in the very next frame (the `candKey` reset below absorbs
    // the candidate list changing under the pointer).
    const cands = hitTest(deps.latestRef.current.snapshot.tree, deps.rectRef.current, point, d.external ? null : d.id, LATH_LAYOUT_OPTS);
    const key = cands.map((c) => JSON.stringify(c.target)).join('|');
    if (key !== d.candKey) {
      d.candKey = key;
      d.depth = 0; // a new candidate list starts at the innermost
    }
    d.candidates = cands;
    if (cands.length === 0) {
      publishPreview(null);
      return;
    }
    d.depth = Math.min(d.depth, cands.length - 1);
    publishPreview(cands[d.depth].previewRect);
  };

  const scheduleHitTest = (): void => {
    const d = drag;
    if (!d || d.rafId !== null) return;
    d.rafId = requestAnimationFrame(() => {
      if (!drag) return;
      drag.rafId = null;
      runHitTest();
    });
  };

  const finish = (commit: boolean): void => {
    const d = drag;
    detach();
    drag = null;
    publishPreview(null);
    if (d && !d.external) {
      const el = deps.leafElsRef.current.get(d.id);
      if (el) el.style.opacity = ''; // un-dim (the move commit tweens it into place)
    }
    if (!d) return;
    if (!d.active) {
      // Sub-threshold press: the click behavior stands (a Door click-reattaches; a
      // header selects). An external press that never became a drag still tells the Wall
      // to drop its transient door-drag state; no click suppression, so the Door's own
      // click still fires.
      if (d.external) deps.latestRef.current.onExternalDrop?.(null);
      return;
    }
    // A real drag happened → swallow the click the browser fires on pointerup so a drop
    // over a header/button/door does not also fire its click.
    deps.suppressNextClickRef.current = true;
    setTimeout(() => {
      deps.suppressNextClickRef.current = false;
    }, 0);
    const chosen = d.candidates.length > 0 ? d.candidates[Math.min(d.depth, d.candidates.length - 1)] : null;
    if (!commit) {
      if (d.external) deps.latestRef.current.onExternalDrop?.(null); // Escape → put the Door back
      return;
    }
    if (d.external) {
      deps.latestRef.current.onExternalDrop?.(chosen ? chosen.target : null);
      return;
    }
    // Internal: a release below the wall minimizes (derived here from the last pointer
    // position); otherwise commit the chosen move.
    const cr = deps.containerRef.current?.getBoundingClientRect();
    if (cr && d.lastY > cr.bottom) {
      deps.latestRef.current.onProposeMinimize?.(d.id);
      return;
    }
    if (chosen) deps.latestRef.current.onProposeMove?.(d.id, chosen.target);
  };

  function onMove(e: PointerEvent): void {
    const d = drag;
    if (!d) return;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    if (!d.active) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD) return;
      d.active = true;
      if (!d.external) {
        deps.latestRef.current.onDragStart?.(d.id); // Wall applies its selection policy
        const el = deps.leafElsRef.current.get(d.id);
        if (el) el.style.opacity = DRAG_DIM;
      }
    }
    scheduleHitTest();
  }

  function onUp(): void {
    finish(true);
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') finish(false);
  }

  function onWheel(e: WheelEvent): void {
    const d = drag;
    if (!d || !d.active || d.candidates.length === 0) return;
    e.preventDefault();
    const n = d.candidates.length;
    const step = e.deltaY > 0 ? 1 : -1; // scroll away/down → one level outward, wrap
    d.depth = ((d.depth + step) % n + n) % n;
    publishPreview(d.candidates[d.depth].previewRect);
  }

  return {
    beginInternal(id, clientX, clientY) {
      // One drag at a time; never during a sash drag or while a leaf is zoomed.
      if (drag || deps.sashDragRef.current) return;
      if (deps.latestRef.current.snapshot.zoomedId !== null) return;
      drag = {
        id, external: false, active: false, startX: clientX, startY: clientY,
        candidates: [], depth: 0, candKey: '', lastX: clientX, lastY: clientY, rafId: null,
      };
      attach();
    },
    beginExternal(id, startX, startY) {
      if (drag) return;
      drag = {
        id, external: true, active: false, startX, startY,
        candidates: [], depth: 0, candKey: '', lastX: startX, lastY: startY, rafId: null,
      };
      attach();
    },
    endExternal() {
      if (drag?.external) {
        detach();
        drag = null;
        publishPreview(null);
      }
    },
    hasDrag() {
      return drag !== null;
    },
    dispose() {
      detach();
    },
  };
}
