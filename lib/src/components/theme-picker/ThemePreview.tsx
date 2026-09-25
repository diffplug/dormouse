import type { CSSProperties } from 'react';
import { PICKER_INSET_BORDER } from '../design';
import { resolveThemeVars, type DormouseTheme } from '../../lib/themes';
import { getThemeSwatchColors, ThemeSwatch, type ThemeSwatchColors } from './ThemeSwatch';

export interface ThemePreviewColors {
  /** The candidate's own terminal palette, for the entry or the trigger. */
  style: CSSProperties;
  swatch: ThemeSwatchColors;
}

/** Resolve a candidate once for everything a preview paints. Resolution uses
 *  the candidate's own polarity, never the active document's theme, and never
 *  applies a theme or touches storage. */
export function getThemePreview(theme: DormouseTheme): ThemePreviewColors {
  const vars = resolveThemeVars(theme);
  return {
    style: {
      backgroundColor: vars['--vscode-terminal-background'],
      color: vars['--vscode-terminal-foreground'],
      boxShadow: PICKER_INSET_BORDER,
    },
    swatch: getThemeSwatchColors(vars),
  };
}

/** Shared by the closed trigger and list rows, independent of the host palette. */
export function ThemePreview({ colors, label }: { colors: ThemeSwatchColors; label: string }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <ThemeSwatch colors={colors} />
      {/* Keep the underline inside the truncation clip: a 4px offset falls
          below the 16px line box at the library's 12px text size. */}
      <span className="min-w-0 truncate decoration-1 underline-offset-2 group-hover/theme-preview:underline">{label}</span>
    </span>
  );
}
