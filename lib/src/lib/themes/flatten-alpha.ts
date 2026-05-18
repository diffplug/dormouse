/* Composite a translucent CSS color over an opaque base, returning an opaque
 * hex result. Used to flatten VSCode tokens that carry alpha (e.g. Selenized
 * Dark's list.activeSelectionBackground = #0096f588) when Dormouse applies
 * them as solid surface fills — the AppBar, dockview tabs, etc. all expect a
 * fully opaque color, but VSCode authors selection tints with alpha because
 * VSCode itself renders them as overlays on the sidebar background. */

interface Rgba { r: number; g: number; b: number; a: number }

const HEX_SHORT = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/i;
const HEX_LONG = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i;
const RGB_FN = /^rgba?\(\s*([0-9.]+)\s*[, ]\s*([0-9.]+)\s*[, ]\s*([0-9.]+)(?:\s*[,/]\s*([0-9.]+%?))?\s*\)$/i;

function parseColor(value: string): Rgba | null {
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

function toHex({ r, g, b }: Rgba): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Composite `value` over `base`. If `value` has no alpha, it's returned
 *  unchanged. If either color can't be parsed, returns `value` as-is. */
export function flattenAlpha(value: string, base: string): string {
  const fg = parseColor(value);
  if (!fg || fg.a >= 1) return value;
  const bg = parseColor(base);
  if (!bg) return value;
  return toHex({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
}

/* VSCode tokens that Dormouse uses as solid surface fills but whose theme
 * authors commonly carry alpha. Flattened against sideBar.background — the
 * surface VSCode itself composites the file-tree selection over. */
const FLATTEN_OVER_SIDEBAR: readonly string[] = [
  '--vscode-list-activeSelectionBackground',
  '--vscode-list-inactiveSelectionBackground',
];

export function flattenSelectionAlpha(vars: Record<string, string>): void {
  const base = vars['--vscode-sideBar-background'];
  if (!base) return;
  for (const name of FLATTEN_OVER_SIDEBAR) {
    const v = vars[name];
    if (v) vars[name] = flattenAlpha(v, base);
  }
}
