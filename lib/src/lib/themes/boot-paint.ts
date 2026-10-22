/**
 * A page's first frame in its theme. `applyTheme` paints only once the page's
 * bundle runs; until then the browser draws the page from its static CSS, so
 * a reader on any other theme saw that frame flash by. A page that carries
 * the boot tag as the first child of `<body>` gets its paint back before the
 * browser draws anything: the last paint this origin remembered, while it is
 * of the theme the reader still has picked, else the page's default, baked
 * into the tag at build.
 */
import type { DormouseTheme } from './types';
import { saveJson } from '../local-json-store';
import { ACTIVE_THEME_KEY } from './store';

/** A theme as painted on `<body>`: its custom properties, and its kind, which
 *  picks the `vscode-light` / `vscode-dark` class and `color-scheme`. */
export interface ThemePaint {
  themeId: string;
  kind: 'light' | 'dark';
  vars: Record<string, string>;
}

/**
 * How a page paints its theme. A page that carries the boot tag sets one
 * before its first restore (`setThemePaintProfile`), so `applyTheme` paints
 * and remembers through it; the build bakes the same profile's default into
 * the tag (`themeBootPaint`).
 */
export interface ThemePaintProfile {
  /** A reader who has picked nothing gets this; absent, the first bundled theme. */
  defaultThemeId?: string;
  /** Custom properties the page derives from each theme, painted with it. */
  derive?: (theme: DormouseTheme, resolvedVars: Record<string, string>) => Record<string, string>;
  /** Classes the page's body carries, which the tag adds before the bundle can. */
  classes?: readonly string[];
}

const PAINT_KEY = 'dormouse:theme-paint';

let profile: ThemePaintProfile | null = null;
let remembered: string | null = null;

export function setThemePaintProfile(next: ThemePaintProfile | null): void {
  profile = next;
}

export function getThemePaintProfile(): ThemePaintProfile | null {
  return profile;
}

/** Remembers `paint` for the next load's boot tag. Only a page with a profile
 *  carries the tag; the one-time page, which keeps nothing, has none. */
export function rememberThemePaint(paint: ThemePaint): void {
  if (!profile) return;
  const raw = JSON.stringify(paint);
  if (raw === remembered) return;
  remembered = raw;
  saveJson(PAINT_KEY, paint);
}

/**
 * The boot tag's code, with `fallback` and `classes` baked in. Run as a
 * classic script, it blocks the parser at the top of `<body>`, before anything
 * below it can be drawn: inline where the page's policy allows it (the
 * website), otherwise the file `themeBootPlugin` emits.
 *
 * A remembered paint is checked the way `getInstalledThemes` checks its rows:
 * only custom properties with string values are written, so a corrupt entry
 * cannot reach any other style.
 */
export function themeBootScript(fallback: ThemePaint, classes: readonly string[] = []): string {
  // `<` escaped so no value can close an inline <script>.
  const baked = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');
  return `(function () {
  var body = document.body, paint = ${baked(fallback)}, classes = ${baked(classes)};
  function valid(candidate) {
    if (!candidate || typeof candidate.themeId !== 'string' || (candidate.kind !== 'light' && candidate.kind !== 'dark') || !candidate.vars || typeof candidate.vars !== 'object') return false;
    for (var name in candidate.vars) if (name.slice(0, 2) !== '--' || typeof candidate.vars[name] !== 'string') return false;
    return true;
  }
  try {
    var active = localStorage.getItem(${baked(ACTIVE_THEME_KEY)});
    var remembered = JSON.parse(localStorage.getItem(${baked(PAINT_KEY)}) || 'null');
    if (valid(remembered) && (!active || remembered.themeId === active)) paint = remembered;
  } catch (e) {}
  for (var name in paint.vars) body.style.setProperty(name, paint.vars[name]);
  body.classList.add('vscode-' + paint.kind);
  body.style.colorScheme = paint.kind;
  for (var i = 0; i < classes.length; i++) body.classList.add(classes[i]);
})();`;
}
