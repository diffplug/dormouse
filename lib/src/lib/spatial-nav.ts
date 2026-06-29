import { type DockviewApi } from 'dockview-react';

export type DoorDirection = 'left' | 'right' | 'above' | 'below';

interface SpatialCandidate { id: string; dist: number; overlaps: boolean }

export function resolvePaneElement(element: HTMLElement | null | undefined): HTMLElement | null {
  if (!element || !element.isConnected) return null;
  return (element.closest('[class*="groupview"]') as HTMLElement | null) ?? element;
}

/**
 * Resolve the dockview *group* element (`dv-groupview`: tab header + content) for
 * a pane id, so selection/spatial bounds cover the whole pane like a terminal.
 *
 * Terminal panes mount their body INSIDE the `dv-groupview`, so climbing via
 * `closest('[class*="groupview"]')` finds the full group. Browser surfaces use
 * dockview's `renderer:'always'`, which mounts the body in a `dv-render-overlay`
 * layer that is a *sibling* of the groupviews and sits only over the content area
 * (below the ~30px tab header). From there the climb finds no groupview and falls
 * back to the shorter body — making the command-mode highlight 30px short and
 * shifted down (diffplug/dormouse: browser highlight not "exactly like a regular
 * terminal"). The panel's `group.element` is the authoritative groupview for
 * either renderer, so prefer it; climb the DOM only as a fallback for transient
 * states where the panel isn't in the api yet.
 */
export function resolvePaneGroupElement(
  api: DockviewApi | null,
  id: string,
  paneElements: Map<string, HTMLElement>,
): HTMLElement | null {
  const groupEl = api?.getPanel(id)?.group?.element ?? null;
  if (groupEl?.isConnected) return groupEl;
  return resolvePaneElement(paneElements.get(id));
}

/** Find the closest adjacent panel to use as a restore anchor.
 *  Returns the neighbor ID and the direction the current panel was relative to it,
 *  which matches Dockview's addPanel position.direction semantics. For example,
 *  if the current panel is to the right of the neighbor, direction='right' means
 *  "place me to the right of this reference panel."
 */
export function findReattachNeighbor(
  currentId: string,
  api: DockviewApi,
  paneElements: Map<string, HTMLElement>,
): { neighborId: string | null; direction: DoorDirection } {
  const currentEl = resolvePaneGroupElement(api, currentId, paneElements);
  if (!currentEl) return { neighborId: null, direction: 'right' };

  const c = currentEl.getBoundingClientRect();
  const EDGE_TOLERANCE = 12;
  let best: { neighborId: string | null; direction: DoorDirection; score: number } = {
    neighborId: null,
    direction: 'right',
    score: Number.POSITIVE_INFINITY,
  };

  for (const panel of api.panels) {
    if (panel.id === currentId) continue;
    const el = resolvePaneGroupElement(api, panel.id, paneElements);
    if (!el) continue;
    const r = el.getBoundingClientRect();

    const verticalOverlap = Math.min(c.bottom, r.bottom) - Math.max(c.top, r.top);
    const horizontalOverlap = Math.min(c.right, r.right) - Math.max(c.left, r.left);
    const candidates: Array<{ direction: DoorDirection; gap: number; overlap: number }> = [];

    if (verticalOverlap > 0) {
      if (Math.abs(c.left - r.right) <= EDGE_TOLERANCE) {
        candidates.push({ direction: 'right', gap: Math.abs(c.left - r.right), overlap: verticalOverlap });
      }
      if (Math.abs(c.right - r.left) <= EDGE_TOLERANCE) {
        candidates.push({ direction: 'left', gap: Math.abs(c.right - r.left), overlap: verticalOverlap });
      }
    }

    if (horizontalOverlap > 0) {
      if (Math.abs(c.top - r.bottom) <= EDGE_TOLERANCE) {
        candidates.push({ direction: 'below', gap: Math.abs(c.top - r.bottom), overlap: horizontalOverlap });
      }
      if (Math.abs(c.bottom - r.top) <= EDGE_TOLERANCE) {
        candidates.push({ direction: 'above', gap: Math.abs(c.bottom - r.top), overlap: horizontalOverlap });
      }
    }

    for (const candidate of candidates) {
      const score = candidate.gap - candidate.overlap / 10000;
      if (score < best.score) {
        best = { neighborId: panel.id, direction: candidate.direction, score };
      }
    }
  }

  return { neighborId: best.neighborId, direction: best.direction };
}

/** Find the nearest panel in the given direction based on DOM positions.
 *  For Left/Right: candidate must overlap vertically with current panel.
 *  For Up/Down: candidate must overlap horizontally with current panel.
 *  Among overlapping candidates, pick the nearest on the primary axis.
 *  If no overlapping candidate, fall back to nearest center in that direction.
 */
export function findPaneInDirection(
  currentId: string,
  direction: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown',
  api: DockviewApi,
  paneElements: Map<string, HTMLElement>,
): string | null {
  const currentEl = resolvePaneGroupElement(api, currentId, paneElements);
  if (!currentEl) return null;
  const c = currentEl.getBoundingClientRect();
  const isHorizontal = direction === 'ArrowLeft' || direction === 'ArrowRight';

  const candidates: SpatialCandidate[] = [];

  for (const panel of api.panels) {
    if (panel.id === currentId) continue;
    const el = resolvePaneGroupElement(api, panel.id, paneElements);
    if (!el) continue;
    const r = el.getBoundingClientRect();

    // Must be in the correct direction on the primary axis
    if (direction === 'ArrowLeft' && r.right > c.left) continue;
    if (direction === 'ArrowRight' && r.left < c.right) continue;
    if (direction === 'ArrowUp' && r.bottom > c.top) continue;
    if (direction === 'ArrowDown' && r.top < c.bottom) continue;

    // Check overlap on the secondary axis (edges, not centers)
    const overlaps = isHorizontal
      ? (r.top < c.bottom && r.bottom > c.top)   // vertical overlap
      : (r.left < c.right && r.right > c.left);  // horizontal overlap

    // Distance on the primary axis (edge-to-edge)
    const dist = isHorizontal
      ? (direction === 'ArrowLeft' ? c.left - r.right : r.left - c.right)
      : (direction === 'ArrowUp' ? c.top - r.bottom : r.top - c.bottom);

    candidates.push({ id: panel.id, dist, overlaps });
  }

  // Prefer overlapping candidates, then nearest
  const overlapping = candidates.filter(c => c.overlaps);
  const pool = overlapping.length > 0 ? overlapping : candidates;
  pool.sort((a, b) => a.dist - b.dist);
  return pool[0]?.id ?? null;
}
