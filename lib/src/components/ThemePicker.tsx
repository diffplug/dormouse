import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { CaretDownIcon } from '@phosphor-icons/react';
import type { DormouseTheme } from '../lib/themes';
import {
  applyTheme,
  getAllThemes,
  getTheme,
  removeInstalledTheme,
  restoreActiveTheme,
  setActiveThemeId,
} from '../lib/themes';
import { ThemeDebuggerDialog } from './ThemeDebugger';
import { ThemeSwatch } from './theme-picker/ThemeSwatch';
import { ThemeStoreDialog } from './theme-picker/ThemeStoreDialog';
import { useCloseOnOutsideAndEscape } from './theme-picker/use-close-on-outside';
import { themePickerStyles as styles } from './theme-picker/styles';
import { chromeButton } from './design';

export type ThemePickerVariant = 'playground-header' | 'standalone-appbar';

export interface ThemePickerProps {
  variant: ThemePickerVariant;
  className?: string;
  /** Theme ID to apply when no theme is persisted yet. Falls back to the
   *  first bundled theme if the ID does not resolve. */
  defaultThemeId?: string;
}

const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function ThemePicker({ variant, className = '', defaultThemeId }: ThemePickerProps) {
  const currentId = useId();
  // Apply the persisted theme during render initialization, before commit, so
  // the first paint already has --vscode-* on body — eliminates the flash of
  // unstyled chrome on the website playground where ThemePicker mounts before
  // any other entry point has a chance to apply a theme.
  const initialState = useRef<{ themes: DormouseTheme[]; activeId: string }>(null);
  if (initialState.current === null) {
    const restored = restoreActiveTheme(defaultThemeId);
    const themes = getAllThemes();
    initialState.current = { themes, activeId: restored?.id ?? themes[0]?.id ?? '' };
  }
  const [themes, setThemes] = useState(initialState.current.themes);
  const [activeId, setActiveId] = useState(initialState.current.activeId);
  const [open, setOpen] = useState(false);
  const [storeOpen, setStoreOpen] = useState(false);
  const [debuggerOpen, setDebuggerOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const isPlayground = variant === 'playground-header';
  const activeTheme = themes.find((theme) => theme.id === activeId) ?? themes[0];

  // React Router document hydration can reconcile <body> after render-time
  // theme application; repeat once after commit so xterm sees real colors.
  useBrowserLayoutEffect(() => {
    const theme = restoreActiveTheme(defaultThemeId);
    if (theme) setActiveId(theme.id);
  }, [defaultThemeId]);

  const closeDropdown = useCallback(() => setOpen(false), []);
  useCloseOnOutsideAndEscape(open, rootRef, closeDropdown);

  const refreshThemes = useCallback(() => {
    setThemes(getAllThemes());
    const theme = restoreActiveTheme(defaultThemeId);
    if (theme) setActiveId(theme.id);
  }, [defaultThemeId]);

  const selectTheme = (id: string) => {
    const theme = getTheme(id);
    if (!theme) return;
    setActiveThemeId(id);
    setActiveId(id);
    applyTheme(theme);
    setOpen(false);
  };

  const deleteTheme = (theme: DormouseTheme) => {
    if (theme.origin.kind !== 'installed') return;
    const confirmed = window.confirm(`Delete "${theme.label}"?`);
    if (!confirmed) return;

    removeInstalledTheme(theme.id);
    setThemes(getAllThemes());

    if (theme.id === activeId) {
      const fallback = restoreActiveTheme(defaultThemeId);
      if (fallback) setActiveId(fallback.id);
    }
  };

  const rootClass = isPlayground
    ? 'relative flex min-w-0 items-baseline'
    : 'relative flex items-center';
  const triggerClass = isPlayground
    ? 'flex w-[116px] min-w-0 cursor-pointer items-baseline justify-end gap-1.5 rounded-md bg-[var(--color-header-inactive-bg)] text-right text-sm text-[var(--color-header-inactive-fg)] sm:w-40 md:w-56'
    : chromeButton({ kind: 'labeled' });
  const menuClass = isPlayground
    ? 'fixed top-16 right-4 left-4 z-50 overflow-hidden rounded border font-mono shadow-2xl md:absolute md:top-full md:right-0 md:left-auto md:mt-2 md:w-[22rem]'
    : 'absolute right-0 top-full z-50 mt-1 w-[280px] overflow-hidden rounded border font-mono shadow-2xl';
  const rowButtonClass = isPlayground
    ? 'flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm'
    : 'flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-sm';
  const swatchSize = isPlayground ? 'md' : 'sm';

  return (
    <div ref={rootRef} className={`${rootClass} ${className}`}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Theme: ${activeTheme?.label ?? 'Select theme'}`}
        data-theme-picker-trigger={isPlayground ? 'playground' : undefined}
        onClick={() => setOpen((value) => !value)}
        className={triggerClass}
      >
        {isPlayground ? (
          <>
            <CaretDownIcon size={10} weight="bold" className="shrink-0 opacity-65" aria-hidden="true" />
            <span
              id={currentId}
              data-theme-picker-current="true"
              className="min-w-0 truncate underline-offset-4 decoration-[var(--color-header-inactive-fg)]"
            >
              {activeTheme?.label ?? 'Select theme'}
            </span>
          </>
        ) : (
          <>
            <span id={currentId}>Theme</span>
            <CaretDownIcon size={10} weight="bold" className="shrink-0 opacity-65" aria-hidden="true" />
          </>
        )}
      </button>

      {open ? (
        <div role="menu" aria-label={isPlayground ? 'Select theme' : undefined} className={menuClass} style={styles.panel}>
          <div className="overflow-y-auto py-1" style={{ maxHeight: isPlayground ? 'min(24rem, calc(100vh - 9rem))' : 320 }}>
            {themes.map((theme) => {
              const isActive = theme.id === activeId;
              const isInstalled = theme.origin.kind === 'installed';
              return (
                <div
                  key={theme.id}
                  className="flex items-center transition-colors"
                  style={isActive ? styles.activeRow : styles.foreground}
                >
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    onClick={() => selectTheme(theme.id)}
                    className={rowButtonClass}
                    style={{ color: 'inherit' }}
                  >
                    <ThemeSwatch theme={theme} size={swatchSize} />
                    <span className="min-w-0 flex-1 truncate">{theme.label}</span>
                  </button>
                  {isInstalled ? (
                    <button
                      type="button"
                      aria-label={`Delete ${theme.label}`}
                      title={`Delete ${theme.label}`}
                      className="mr-2 flex h-5 w-5 shrink-0 items-center justify-center rounded text-sm opacity-60 transition-opacity hover:opacity-100 focus:opacity-100"
                      style={{ color: 'inherit' }}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        deleteTheme(theme);
                      }}
                    >
                      X
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>

          <div className="border-t p-1" style={styles.border}>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setDebuggerOpen(true);
              }}
              className={`w-full rounded text-left text-sm font-medium transition-opacity hover:opacity-85 ${
                isPlayground ? 'px-3 py-2' : 'px-3 py-1.5'
              }`}
              style={styles.foreground}
            >
              Debug current theme
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setStoreOpen(true);
              }}
              className={`w-full rounded text-left text-sm font-medium transition-opacity hover:opacity-85 ${
                isPlayground ? 'px-3 py-2' : 'px-3 py-1.5'
              }`}
              style={styles.link}
            >
              Install theme from OpenVSX
            </button>
          </div>
        </div>
      ) : null}

      <ThemeStoreDialog open={storeOpen} onClose={() => setStoreOpen(false)} onThemesChanged={refreshThemes} />
      <ThemeDebuggerDialog open={debuggerOpen} onClose={() => setDebuggerOpen(false)} />
    </div>
  );
}
