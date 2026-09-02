import { useEffect, useLayoutEffect, useRef } from 'react';
import { restoreActiveTheme, setDefaultThemeId } from './apply';

const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Apply the persisted theme (falling back to `defaultThemeId`) before first
 * paint, then again after commit.
 *
 * The repeat is for React Router document hydration, which can reconcile the
 * server `<body>` and drop the render-time `body.style` writes — without it
 * xterm can initialize against fallback colors.
 *
 * Every host needs its own restore now that the theme picker lives inside the
 * Settings dialog and only mounts when the user opens it
 * (docs/specs/theme.md). `restore` lets a host layer on browser-chrome work of
 * its own; Pocket uses it for `color-scheme` and the `theme-color` meta.
 */
export function useRestoredTheme(
  defaultThemeId?: string,
  restore: () => void = restoreActiveTheme,
): void {
  // Latched before the first restore, and before any child renders: the theme
  // picker re-resolves through this fallback, and on some pages it mounts
  // ahead of the component that calls this hook.
  setDefaultThemeId(defaultThemeId ?? null);

  const restoredRef = useRef(false);
  if (!restoredRef.current) {
    restore();
    restoredRef.current = true;
  }
  useBrowserLayoutEffect(() => {
    setDefaultThemeId(defaultThemeId ?? null);
    restore();
  }, [defaultThemeId, restore]);
}
