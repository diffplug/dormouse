import { THEME_BOOT_SCRIPT, themeBootAttributes, type ThemePaint } from './boot-paint';

/**
 * The theme boot tag (`./boot-paint.ts`) for a prerendered React page, inline:
 * render it first, so it is the first node in `<body>`. React never runs a
 * script it inserts itself, so it runs once, from the prerendered HTML, and a
 * client navigation only updates the scope `rememberThemePaint` reads.
 */
export function ThemeBootScript({ scope, paint, classes }: { scope: string; paint: ThemePaint; classes?: readonly string[] }) {
  return <script {...themeBootAttributes(scope, paint, classes)} dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />;
}
