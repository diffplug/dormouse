/** The pure half of the Markdown editor's image resize handles
 * (./image-resize.tsx): what size a corner drag gives, and whether it saves. */

export interface Size { width: number; height: number }

/** How far, in CSS pixels, a handle travels before its drag resizes. */
export const DRAG_THRESHOLD = 2;

/** Whether a handle's travel (`dx`, `dy`) is past `DRAG_THRESHOLD`. */
export const pastThreshold = (dx: number, dy: number): boolean => Math.hypot(dx, dy) >= DRAG_THRESHOLD;

/** The size an image shown at `start` takes when a corner handle travels
 * (`dx`, `dy`), positive away from the opposite corner: its travel along the
 * corner's diagonal, so the aspect holds, its width within `min` and `max`. */
export function dragSize(start: Size, dx: number, dy: number, min: number, max: number): Size {
  const { width: w, height: h } = start;
  const width = Math.round(Math.min(max, Math.max(min, w + (dx * w + dy * h) * w / (w ** 2 + h ** 2))));
  return { width, height: Math.round(width * h / w) };
}

/** The size a released drag saves: none when it ends at the width it started at. */
export const savedSize = (start: Size, size: Size | null): Size | null =>
  size && size.width !== Math.round(start.width) ? size : null;
