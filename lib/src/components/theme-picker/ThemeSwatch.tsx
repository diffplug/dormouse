import { dynamicPaletteValuesFrom, pickDynamicPalette } from '../../lib/themes';
import { parseColorRgb } from '../../lib/css-color';
import { flattenAlpha } from '../../lib/themes/flatten-alpha';

export interface ThemeSwatchColors {
  active: string;
  focus: string;
}

/** The chrome accents of an already-resolved theme (`resolveThemeVars`): the
 *  active header fill and the focus ring the runtime would pick for it. Not the
 *  terminal background: the row already shows it, and on Quiet Light a
 *  background circle plus a focus dot hid the green header fill. */
export function getThemeSwatchColors(vars: Record<string, string>): ThemeSwatchColors {
  const palette = pickDynamicPalette(
    dynamicPaletteValuesFrom('vscodeVar', (name) => vars[name] ?? ''),
    parseColorRgb,
  );
  return {
    active: vars['--vscode-list-activeSelectionBackground'],
    // The ring is painted over app chrome. Preserve that appearance even
    // when the swatch is placed over the candidate's terminal background.
    focus: flattenAlpha(palette.focusRing?.value ?? vars['--vscode-focusBorder'], vars['--vscode-sideBar-background']),
  };
}

export function ThemeSwatch({ colors }: { colors: ThemeSwatchColors }) {
  return (
    <span
      aria-hidden="true"
      data-theme-swatch=""
      className="relative flex h-4 w-4 shrink-0 items-center justify-center"
    >
      <span
        className="block h-4 w-4 rounded-full border border-current/25"
        style={{ backgroundColor: colors.active }}
      />
      {/* 7px: the largest dot that still leaves the header fill legible. */}
      <span
        className="absolute -right-0.5 -bottom-0.5 size-[7px] rounded-full"
        style={{ backgroundColor: colors.focus }}
      />
    </span>
  );
}
