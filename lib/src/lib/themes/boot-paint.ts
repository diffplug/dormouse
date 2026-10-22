/**
 * A page's first frame in its theme. `applyTheme` paints only once the page's
 * bundle runs; until then the browser draws the page from its static CSS, so
 * a reader on any other theme saw that frame flash by. A page that carries
 * the boot tag as the first child of `<body>` gets its paint back before the
 * browser draws anything: the last one this origin remembered for the tag's
 * scope, or on a first visit the default the tag was built with.
 */
import type { DormouseTheme } from './types';
import { getStorage } from '../local-json-store';

/** What the boot tag writes onto `<body>`: the theme's kind, which picks the
 *  `vscode-light` / `vscode-dark` class and `color-scheme`, and its custom
 *  properties. */
export interface ThemePaint {
  kind: 'light' | 'dark';
  vars: Record<string, string>;
}

const STORAGE_PREFIX = 'dormouse:theme-paint:';
const BOOT_TAG_SELECTOR = 'script[data-theme-paint]';

/**
 * The boot tag's code, run as a classic script so it blocks the parser at the
 * top of `<body>`, before anything below it can be drawn. Inline where the
 * page's policy allows it (the website), otherwise the file
 * `themeBootPlugin` emits. Reads its configuration off its own tag.
 *
 * A remembered paint is checked the way `getInstalledThemes` checks its rows:
 * only custom properties with string values are written, so a corrupt entry
 * cannot reach any other style.
 */
export const THEME_BOOT_SCRIPT = `(function () {
  var tag = document.currentScript, body = document.body;
  if (!tag || !body) return;
  function valid(paint) {
    if (!paint || (paint.kind !== 'light' && paint.kind !== 'dark') || !paint.vars || typeof paint.vars !== 'object') return false;
    for (var name in paint.vars) if (name.slice(0, 2) !== '--' || typeof paint.vars[name] !== 'string') return false;
    return true;
  }
  function parse(raw) { try { var paint = JSON.parse(raw || 'null'); return valid(paint) ? paint : null; } catch (e) { return null; } }
  var remembered = null;
  try { remembered = parse(localStorage.getItem('${STORAGE_PREFIX}' + tag.getAttribute('data-theme-paint'))); } catch (e) {}
  var paint = remembered || parse(tag.getAttribute('data-theme-default'));
  if (!paint) return;
  for (var name in paint.vars) body.style.setProperty(name, paint.vars[name]);
  body.classList.add('vscode-' + paint.kind);
  body.style.colorScheme = paint.kind;
  var classes = (tag.getAttribute('data-theme-classes') || '').split(' ');
  for (var i = 0; i < classes.length; i++) if (classes[i]) body.classList.add(classes[i]);
})();`;

/** A theme's paint as `applyTheme` leaves it: its `resolveThemeVars`, plus
 *  any a page derives from them. Built at build time for the boot tag's
 *  first-visit default. */
export function themePaintFor(theme: DormouseTheme, vars: Record<string, string>): ThemePaint {
  return { kind: theme.type, vars };
}

/**
 * The boot tag's attributes. `scope` names the remembered paint, so pages on
 * one origin that paint differently (the website's docs and its playground)
 * never replay each other's; `classes` are ones the page's body always carries
 * once its bundle runs.
 */
export function themeBootAttributes(scope: string, fallback: ThemePaint, classes: readonly string[] = []): Record<string, string> {
  return {
    'data-theme-paint': scope,
    'data-theme-default': JSON.stringify(fallback),
    'data-theme-classes': classes.join(' '),
  };
}

/**
 * Remembers `<body>`'s current paint for the page's boot tag, if it has one.
 * Called after every paint, so a pick made in one tab is what the next load
 * starts from. A page without the tag (Storybook, VS Code, the one-time page,
 * which keeps nothing) remembers nothing.
 */
export function rememberThemePaint(): void {
  if (typeof document === 'undefined') return;
  const scope = document.querySelector(BOOT_TAG_SELECTOR)?.getAttribute('data-theme-paint');
  if (!scope) return;
  const { body } = document;
  const vars: Record<string, string> = {};
  for (const name of body.style) {
    if (name.startsWith('--')) vars[name] = body.style.getPropertyValue(name);
  }
  const paint: ThemePaint = { kind: body.classList.contains('vscode-light') ? 'light' : 'dark', vars };
  try {
    getStorage()?.setItem(STORAGE_PREFIX + scope, JSON.stringify(paint));
  } catch {
    // A full or blocked store costs only the next load's first frame.
  }
}
