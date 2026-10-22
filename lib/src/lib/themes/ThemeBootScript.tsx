import { themeBootPaint } from './apply';
import { themeBootScript, type ThemePaintProfile } from './boot-paint';

/**
 * The theme boot tag (`./boot-paint.ts`) for a prerendered React page, inline:
 * render it first, so it is the first node in `<body>`. Only the prerender
 * fills it: the tag has run before hydration, and React never runs a script
 * it inserts, so the client keeps the prerendered text rather than computing
 * the paint again.
 */
export function ThemeBootScript({ profile }: { profile: ThemePaintProfile }) {
  const code = import.meta.env.SSR ? themeBootScript(themeBootPaint(profile), profile.classes) : '';
  return <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: code }} />;
}
