/**
 * The renderer side of a preview slot switch (`docs/specs/dor-tool.md` ->
 * Switching the slot): the ghost a switch captures when it begins, and the
 * hooks the Tool body and headers read it through. The lifecycle is
 * `lib/src/lib/preview-transition-store.ts`.
 */
import { useState, useSyncExternalStore } from 'react';
import {
  beginPreviewTransition,
  getPreviewSlotView,
  subscribeToPreviewTransitions,
  type GhostRect,
  type PreviewGhost,
  type PreviewSlotView,
  type PreviewTransition,
} from '../../lib/preview-transition-store';
import { motionIsInstant } from '../../lib/ui-geometry';
import { getAgentBrowserSurfaceController } from './agent-browser-surface-controller';
import { resolveRenderMode, toolFace, type ToolFace } from './browser-surface';

/** Marks a Tool's browser layer, the box a screencast snapshot is placed in. */
export const BROWSER_LAYER_ATTRIBUTE = 'data-browser-layer';

/**
 * Begin a switch on the slot `id`, or take over the one in progress. What the
 * slot shows is captured only for a new switch, and only on a face with
 * something to hold.
 */
export function beginSlotSwitch(id: string, params: () => Record<string, unknown> | undefined): number | null {
  return beginPreviewTransition(id, () => {
    const current = params();
    return current ? capturePreviewGhost(id, current) : null;
  }, motionIsInstant());
}

/** What a switch on this Tool leaf holds, captured now; null on a face with
 *  nothing to hold (approval, a port conflict). */
function capturePreviewGhost(id: string, params: Record<string, unknown>): PreviewGhost | null {
  const face = toolFace(params);
  if (face === 'terminal') return { kind: 'terminal' };
  if (face !== 'browser') return null;
  // A loaded document stays painted after its server exits, and blurs across
  // origins, so the iframe itself is kept; a screencast's session closes.
  if (resolveRenderMode(params) === 'iframe') {
    return { kind: 'layer', generation: getPreviewSlotView(id).generation, params };
  }
  const canvas = getAgentBrowserSurfaceController(id)?.frameCanvas() ?? null;
  return { kind: 'image', frame: canvas && snapshotScreencast(canvas, canvas.closest(`[${BROWSER_LAYER_ATTRIBUTE}]`)) };
}

/** A copy of a screencast canvas's current frame, placed where the canvas sits
 *  in `layer`; null when it shows no frame. Copied canvas to canvas, so nothing
 *  is encoded. */
export function snapshotScreencast(
  canvas: HTMLCanvasElement,
  layer: Pick<Element, 'getBoundingClientRect'> | null,
): { canvas: HTMLCanvasElement; rect: GhostRect } | null {
  if (!layer || !canvas.width || !canvas.height) return null;
  const box = canvas.getBoundingClientRect();
  // A hidden canvas — no frame yet, or popped out — measures nothing.
  if (!box.width || !box.height) return null;
  const copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  const context = copy.getContext('2d');
  if (!context) return null;
  context.drawImage(canvas, 0, 0);
  copy.className = 'block h-full w-full';
  const origin = layer.getBoundingClientRect();
  return { canvas: copy, rect: { left: box.left - origin.left, top: box.top - origin.top, width: box.width, height: box.height } };
}

export function usePreviewSlotView(id: string): PreviewSlotView {
  return useSyncExternalStore(subscribeToPreviewTransitions, () => getPreviewSlotView(id));
}

/** The face a Tool shows: during a switch, its ghost's. */
export function shownToolFace(params: unknown, transition: PreviewTransition | null): ToolFace {
  const face = toolFace(params);
  if (!transition || face === 'pending-approval' || face === 'port-conflict') return face;
  return transition.ghost.kind === 'terminal' ? 'terminal' : 'browser';
}

/** `live` as it was on the first render `holding` was true, until holding
 *  ends: what a header shows through a switch. The switch begins before any
 *  retarget writes, so that render still sees the old view. */
export function useHeldWhile<T>(live: T, holding: boolean): T {
  const [held, setHeld] = useState<{ value: T } | null>(null);
  // Set while rendering: React renders again at once, before any children.
  if (holding && !held) setHeld({ value: live });
  else if (!holding && held) setHeld(null);
  return held ? held.value : live;
}
