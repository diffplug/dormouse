/** The image editor's pixel core: hard-edged, integer raster operations with
 * no DOM. Drawing never antialiases, so it writes only the colors it is given. */

/** RGBA pixels, row-major; an `ImageData` is one. */
export interface Raster { width: number; height: number; data: Uint8ClampedArray }
/** Channels 0–255. */
export type Rgba = readonly [r: number, g: number, b: number, a: number];
export interface Rect { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }
/** One byte per raster pixel, row-major; nonzero is selected. */
export type Mask = Uint8Array;

export function createRaster(width: number, height: number): Raster {
  width = Math.max(0, Math.floor(width));
  height = Math.max(0, Math.floor(height));
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/** `rect` with its corners rounded, normalized, and clipped to the raster; null when empty. */
export function clipRect(r: { width: number; height: number }, rect: Rect): Rect | null {
  const ax = Math.round(rect.x), bx = Math.round(rect.x + rect.width);
  const ay = Math.round(rect.y), by = Math.round(rect.y + rect.height);
  const x0 = Math.max(0, Math.min(ax, bx)), x1 = Math.min(r.width, Math.max(ax, bx));
  const y0 = Math.max(0, Math.min(ay, by)), y1 = Math.min(r.height, Math.max(ay, by));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/** The pixel containing (x, y); null off the raster. */
export function pixel(r: Raster, x: number, y: number): Rgba | null {
  x = Math.floor(x); y = Math.floor(y);
  if (x < 0 || y < 0 || x >= r.width || y >= r.height) return null;
  const i = (y * r.width + x) * 4, d = r.data;
  return [d[i], d[i + 1], d[i + 2], d[i + 3]];
}

/** `#rrggbb`, with an alpha byte only when it is below 255. */
export function toHex([red, green, blue, alpha]: Rgba): string {
  const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${hex(red)}${hex(green)}${hex(blue)}${alpha < 255 ? hex(alpha) : ''}`;
}

const pack = (d: Uint8ClampedArray, i: number) => ((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]) >>> 0;
const unpack = (n: number): Rgba => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

function put(d: Uint8ClampedArray, i: number, [red, green, blue, alpha]: Rgba) {
  d[i] = red; d[i + 1] = green; d[i + 2] = blue; d[i + 3] = alpha;
}

export function fillRect(r: Raster, rect: Rect, color: Rgba): void {
  const c = clipRect(r, rect);
  if (c) for (let y = c.y; y < c.y + c.height; y++) {
    for (let x = c.x; x < c.x + c.width; x++) put(r.data, (y * r.width + x) * 4, color);
  }
}

/** A copy of the part of `rect` on the raster; 0×0 when none is. */
export function crop(r: Raster, rect: Rect): Raster {
  const c = clipRect(r, rect);
  if (!c) return createRaster(0, 0);
  const out = createRaster(c.width, c.height);
  for (let y = 0; y < c.height; y++) {
    const from = ((c.y + y) * r.width + c.x) * 4;
    out.data.set(r.data.subarray(from, from + c.width * 4), y * c.width * 4);
  }
  return out;
}

/** `crop`, with pixels outside `mask` made transparent. */
export function copyRegion(r: Raster, rect: Rect, mask?: Mask): Raster {
  const out = crop(r, rect);
  const c = clipRect(r, rect);
  if (mask && c) for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      if (!mask[(c.y + y) * r.width + c.x + x]) out.data[(y * c.width + x) * 4 + 3] = 0;
    }
  }
  return out;
}

/** Draws `src` with its top-left at (x, y): fully transparent pixels are skipped, the rest overwrite. */
export function paste(dst: Raster, src: Raster, x: number, y: number): void {
  x = Math.round(x); y = Math.round(y);
  const x0 = Math.max(0, -x), x1 = Math.min(src.width, dst.width - x);
  const y0 = Math.max(0, -y), y1 = Math.min(src.height, dst.height - y);
  for (let sy = y0; sy < y1; sy++) {
    for (let sx = x0; sx < x1; sx++) {
      const s = (sy * src.width + sx) * 4;
      if (src.data[s + 3] === 0) continue;
      dst.data.set(src.data.subarray(s, s + 4), ((y + sy) * dst.width + x + sx) * 4);
    }
  }
}

/** Offsets of a `size`-pixel brush around its anchor; round drops corners. */
function stamp(size: number, shape: 'square' | 'round'): [number, number][] {
  const start = -Math.floor((size - 1) / 2), half = size / 2, limit = half * half - 0.5;
  const offsets: [number, number][] = [];
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const dx = i + 0.5 - half, dy = j + 0.5 - half;
      if (shape === 'square' || size <= 2 || dx * dx + dy * dy <= limit) offsets.push([start + i, start + j]);
    }
  }
  return offsets;
}

/** A Bresenham line from the pixel containing (x0, y0) to the one containing
 * (x1, y1), stamping a brush at every step; diagonal steps keep it connected. */
export function drawLine(
  r: Raster, x0: number, y0: number, x1: number, y1: number,
  size: number, color: Rgba, shape: 'square' | 'round' = 'square',
): void {
  const brush = stamp(Math.max(1, Math.round(size)), shape);
  let x = Math.floor(x0), y = Math.floor(y0);
  const tx = Math.floor(x1), ty = Math.floor(y1);
  const dx = Math.abs(tx - x), dy = -Math.abs(ty - y), sx = x < tx ? 1 : -1, sy = y < ty ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    for (const [ox, oy] of brush) {
      const px = x + ox, py = y + oy;
      if (px >= 0 && py >= 0 && px < r.width && py < r.height) put(r.data, (py * r.width + px) * 4, color);
    }
    if (x === tx && y === ty) return;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}

/** Fills the 4-connected region around (x, y) whose pixels are each within
 * `tolerance` of the seed on every channel (0 = exact). Returns the bounds it
 * filled; null off the raster, or when the seed already is `color` at tolerance 0. */
export function floodFill(r: Raster, x: number, y: number, color: Rgba, tolerance = 0): Rect | null {
  x = Math.floor(x); y = Math.floor(y);
  const { width, height, data } = r;
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  const seed = pixel(r, x, y)!;
  if (tolerance <= 0 && seed.every((v, k) => v === color[k])) return null;
  const visited = new Uint8Array(width * height);
  const matches = (p: number) => {
    if (visited[p]) return false;
    const i = p * 4;
    return Math.abs(data[i] - seed[0]) <= tolerance && Math.abs(data[i + 1] - seed[1]) <= tolerance
      && Math.abs(data[i + 2] - seed[2]) <= tolerance && Math.abs(data[i + 3] - seed[3]) <= tolerance;
  };
  let minX = x, maxX = x, minY = y, maxY = y;
  // An explicit stack of pixel indices, one seed per run, so depth never grows with the image.
  const stack = [y * width + x];
  while (stack.length) {
    const p = stack.pop()!;
    if (!matches(p)) continue;
    const row = Math.floor(p / width), base = row * width;
    let left = p - base, right = left;
    while (left > 0 && matches(base + left - 1)) left--;
    while (right < width - 1 && matches(base + right + 1)) right++;
    for (let i = left; i <= right; i++) { visited[base + i] = 1; put(data, (base + i) * 4, color); }
    minX = Math.min(minX, left); maxX = Math.max(maxX, right);
    minY = Math.min(minY, row); maxY = Math.max(maxY, row);
    for (const next of [row - 1, row + 1]) {
      if (next < 0 || next >= height) continue;
      let inRun = false;
      for (let i = left; i <= right; i++) {
        const q = next * width + i, ok = matches(q);
        if (ok && !inRun) stack.push(q);
        inRun = ok;
      }
    }
  }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** The pixels whose centers lie inside the polygon, by the even-odd rule. */
export function polygonMask(width: number, height: number, points: readonly Point[]): Mask {
  const mask = new Uint8Array(width * height);
  if (points.length < 3) return mask;
  const crossings: number[] = [];
  for (let y = 0; y < height; y++) {
    const cy = y + 0.5;
    crossings.length = 0;
    for (let k = 0; k < points.length; k++) {
      const a = points[k], b = points[(k + 1) % points.length];
      if ((a.y <= cy) !== (b.y <= cy)) crossings.push(a.x + (cy - a.y) / (b.y - a.y) * (b.x - a.x));
    }
    crossings.sort((p, q) => p - q);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const from = Math.max(0, Math.ceil(crossings[k] - 0.5)), to = Math.min(width - 1, Math.ceil(crossings[k + 1] - 0.5) - 1);
      mask.fill(1, y * width + from, y * width + to + 1);
    }
  }
  return mask;
}

/** The bounds of a mask's selected pixels; null when none are. */
export function maskBounds(mask: Mask, width: number, height: number): Rect | null {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      maxY = y;
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Whether pixel (x, y) is in the selection `rect` ∩ `mask`. */
const selected = (r: Raster, c: Rect, mask: Mask | undefined, x: number, y: number) =>
  x >= c.x && y >= c.y && x < c.x + c.width && y < c.y + c.height && (!mask || mask[y * r.width + x] !== 0);

/** The most common color among unselected pixels 8-adjacent to the selection
 * (`rect`, narrowed by `mask`); ties go to the first in row order. Null when the
 * selection has no such ring, as when it covers the image. */
export function dominantBorderColor(r: Raster, rect: Rect, mask?: Mask): Rgba | null {
  const c = clipRect(r, rect);
  if (!c) return null;
  const counts = new Map<number, number>();
  let best = -1, bestCount = 0;
  for (let y = Math.max(0, c.y - 1); y < Math.min(r.height, c.y + c.height + 1); y++) {
    for (let x = Math.max(0, c.x - 1); x < Math.min(r.width, c.x + c.width + 1); x++) {
      if (selected(r, c, mask, x, y)) continue;
      let touches = false;
      for (let oy = -1; oy <= 1 && !touches; oy++) {
        for (let ox = -1; ox <= 1 && !touches; ox++) touches = selected(r, c, mask, x + ox, y + oy);
      }
      if (!touches) continue;
      const key = pack(r.data, (y * r.width + x) * 4), n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      if (n > bestCount) { best = key; bestCount = n; }
    }
  }
  return bestCount ? unpack(best) : null;
}

/** Paints the selection (`rect`, narrowed by `mask`) with `color`. */
export function fillHole(r: Raster, rect: Rect, mask: Mask | undefined, color: Rgba): void {
  const c = clipRect(r, rect);
  if (c) for (let y = c.y; y < c.y + c.height; y++) {
    for (let x = c.x; x < c.x + c.width; x++) if (!mask || mask[y * r.width + x]) put(r.data, (y * r.width + x) * 4, color);
  }
}

/** Cuts the selection out of `r`: returns its pixels (transparent outside
 * `mask`) and where they sat, and fills the hole with the ring's dominant
 * color, or transparent when there is no ring. Null when the selection is off the raster. */
export function liftSelection(r: Raster, rect: Rect, mask?: Mask): { pixels: Raster; at: Rect; fill: Rgba } | null {
  const at = clipRect(r, rect);
  if (!at) return null;
  const pixels = copyRegion(r, at, mask);
  const fill = dominantBorderColor(r, at, mask) ?? [0, 0, 0, 0];
  fillHole(r, at, mask, fill);
  return { pixels, at, fill };
}

/** A copy of `r` with `amount` columns (`x`) or rows (`y`) opened before index
 * `at`, each a replica of the column or row just before the seam (at it when `at` is 0). */
export function insertSeam(r: Raster, axis: 'x' | 'y', at: number, amount: number): Raster {
  amount = Math.max(0, Math.round(amount));
  const { width, height, data } = r;
  if (axis === 'x') {
    at = Math.max(0, Math.min(width, Math.round(at)));
    const out = createRaster(width + amount, height), src = Math.max(0, at - 1);
    for (let y = 0; y < height; y++) {
      const row = y * width * 4, dst = y * out.width * 4;
      out.data.set(data.subarray(row, row + at * 4), dst);
      if (width) for (let k = 0; k < amount; k++) out.data.set(data.subarray(row + src * 4, row + src * 4 + 4), dst + (at + k) * 4);
      out.data.set(data.subarray(row + at * 4, row + width * 4), dst + (at + amount) * 4);
    }
    return out;
  }
  at = Math.max(0, Math.min(height, Math.round(at)));
  const out = createRaster(width, height + amount), stride = width * 4, src = Math.max(0, at - 1);
  out.data.set(data.subarray(0, at * stride), 0);
  if (height) for (let k = 0; k < amount; k++) out.data.set(data.subarray(src * stride, (src + 1) * stride), (at + k) * stride);
  out.data.set(data.subarray(at * stride), (at + amount) * stride);
  return out;
}

/** A copy of `r` without the columns (`x`) or rows (`y`) from `from` up to, not including, `to`. */
export function removeSeam(r: Raster, axis: 'x' | 'y', from: number, to: number): Raster {
  const { width, height, data } = r, extent = axis === 'x' ? width : height;
  const a = Math.max(0, Math.min(extent, Math.round(Math.min(from, to))));
  const b = Math.max(0, Math.min(extent, Math.round(Math.max(from, to))));
  if (axis === 'x') {
    const out = createRaster(width - (b - a), height);
    for (let y = 0; y < height; y++) {
      const row = y * width * 4, dst = y * out.width * 4;
      out.data.set(data.subarray(row, row + a * 4), dst);
      out.data.set(data.subarray(row + b * 4, row + width * 4), dst + a * 4);
    }
    return out;
  }
  const out = createRaster(width, height - (b - a)), stride = width * 4;
  out.data.set(data.subarray(0, a * stride), 0);
  out.data.set(data.subarray(b * stride), a * stride);
  return out;
}
