/* Composite a translucent CSS color over an opaque base, returning an opaque
 * hex result. Used to flatten VSCode tokens that carry alpha (e.g. Selenized
 * Dark's list.activeSelectionBackground = #0096f588) when Dormouse applies
 * them as solid surface fills — the AppBar, dockview tabs, etc. all expect a
 * fully opaque color, but VSCode authors selection tints with alpha because
 * VSCode itself renders them as overlays on the sidebar background. */

import { parseColor, toHex } from '../css-color';

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
