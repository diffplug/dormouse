import { useEffect, useLayoutEffect, useRef } from 'react';
import { restoreActiveTheme } from './apply';

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
  restore: (defaultThemeId?: string) => void = restoreActiveTheme,
): void {
  const restoredRef = useRef(false);
  if (!restoredRef.current) {
    restore(defaultThemeId);
    restoredRef.current = true;
  }
  useBrowserLayoutEffect(() => {
    restore(defaultThemeId);
  }, [defaultThemeId, restore]);
}
