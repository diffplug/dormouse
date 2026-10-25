/** Where the image sits in the editor's canvas. `zoom` is device pixels per
 * image pixel, so 100% shows each image pixel on one screen pixel (a 2×
 * screenshot at its natural size); `x`/`y` place the image's origin, in
 * device pixels from the canvas's top-left. */
export interface View { zoom: number; x: number; y: number; fit: boolean }

const MIN_ZOOM = 0.02, MAX_ZOOM = 64;
const STEPS = [0.05, 0.1, 0.125, 0.25, 1 / 3, 0.5, 2 / 3, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];

/** The whole image, centered, never enlarged past 100%. */
export function fitView(w: number, h: number, viewW: number, viewH: number): View {
  const zoom = w && h ? Math.max(MIN_ZOOM, Math.min(1, (viewW - 16) / w, (viewH - 16) / h)) : 1;
  return center(zoom, w, h, viewW, viewH, true);
}

export function center(zoom: number, w: number, h: number, viewW: number, viewH: number, fit = false): View {
  return { zoom, x: Math.round((viewW - w * zoom) / 2), y: Math.round((viewH - h * zoom) / 2), fit };
}

/** `view` zoomed to `zoom` (clamped) about the device point (cx, cy), which stays put. */
export function zoomAt(view: View, zoom: number, cx: number, cy: number): View {
  zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
  const k = zoom / view.zoom;
  return { zoom, x: cx - (cx - view.x) * k, y: cy - (cy - view.y) * k, fit: false };
}

/** The next preset zoom level up (`dir` 1) or down (-1). */
export function stepZoom(zoom: number, dir: 1 | -1): number {
  if (dir > 0) return STEPS.find(s => s > zoom * 1.001) ?? MAX_ZOOM;
  return [...STEPS].reverse().find(s => s < zoom / 1.001) ?? MIN_ZOOM;
}

/** Keeps at least `margin` device pixels of the image inside the canvas. */
export function clampView(view: View, w: number, h: number, viewW: number, viewH: number, margin = 48): View {
  const iw = w * view.zoom, ih = h * view.zoom;
  const mx = Math.min(margin, iw), my = Math.min(margin, ih);
  const x = Math.max(mx - iw, Math.min(viewW - mx, view.x)), y = Math.max(my - ih, Math.min(viewH - my, view.y));
  return x === view.x && y === view.y ? view : { ...view, x, y };
}
