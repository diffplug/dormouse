/* Pure CSS color-string parsing — no DOM, safe in the browser and the Node
 * extension host. Shared by theme alpha-flattening (`themes/flatten-alpha.ts`)
 * and OSC 10/11/12 color-query replies (`terminal-protocol.ts`). */

export interface Rgba { r: number; g: number; b: number; a: number }

const HEX_SHORT = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/i;
const HEX_LONG = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i;
const RGB_FN = /^rgba?\(\s*([0-9.]+)\s*[, ]\s*([0-9.]+)\s*[, ]\s*([0-9.]+)(?:\s*[,/]\s*([0-9.]+%?))?\s*\)$/i;

/** Parse a `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` / `rgb()` / `rgba()`
 *  color string to 0–255 channels + 0–1 alpha. Returns null if unparseable. */
export function parseColor(value: string): Rgba | null {
  const v = value.trim();

  let m = HEX_SHORT.exec(v);
  if (m) {
    const dup = (h: string) => parseInt(h + h, 16);
    return { r: dup(m[1]), g: dup(m[2]), b: dup(m[3]), a: m[4] ? dup(m[4]) / 255 : 1 };
  }

  m = HEX_LONG.exec(v);
  if (m) {
    return {
      r: parseInt(m[1], 16),
      g: parseInt(m[2], 16),
      b: parseInt(m[3], 16),
      a: m[4] ? parseInt(m[4], 16) / 255 : 1,
    };
  }

  m = RGB_FN.exec(v);
  if (m) {
    const a = m[4] ? (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])) : 1;
    return { r: parseFloat(m[1]), g: parseFloat(m[2]), b: parseFloat(m[3]), a };
  }

  return null;
}

/** Format the RGB channels of an `Rgba` as an opaque `#rrggbb` string (alpha dropped). */
export function toHex({ r, g, b }: Rgba): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}
