import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
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
import { chromeButton, useMeasuredElementRect } from './design';
import { clampOverlayPosition, OVERLAY_VIEWPORT_MARGIN_PX } from '../lib/ui-geometry';

/**
 * `compact` is the free-floating trigger used by the website's Pocket
 * playground pages, which have no baseboard and therefore no Settings dialog.
 * `settings-dialog` is the row inside the Settings dialog, which is where every
 * host with a baseboard sets its theme (docs/specs/theme.md).
 */
export type ThemePickerVariant = 'compact' | 'settings-dialog';

export interface ThemePickerProps {
  variant: ThemePickerVariant;
  /** Theme ID to apply when no theme is persisted yet. Falls back to the
   *  first bundled theme if the ID does not resolve. */
  defaultThemeId?: string;
  /** Controlled dropdown state. Omit both for the uncontrolled default; the
   *  Settings dialog controls them so its `onEscape` can close the menu before
   *  the dialog itself (`ModalFrame`'s capture-phase Escape handler would
   *  otherwise swallow the key before the picker ever sees it). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Menu width. Mirrored by the `w-[280px]` literal on the non-dialog variant,
 *  which Tailwind must be able to scan statically. */
const MENU_WIDTH_PX = 280;
const MENU_MAX_HEIGHT = `calc(100vh - ${OVERLAY_VIEWPORT_MARGIN_PX * 2}px)`;

export function ThemePicker({
  variant,
  defaultThemeId,
  open: controlledOpen,
  onOpenChange,
}: ThemePickerProps) {
  // Apply the persisted theme during render initialization, before commit, so
  // the first paint already has --vscode-* on body. Hosts must not *rely* on
  // this: inside the Settings dialog the picker only mounts once the user opens
  // it, so each host restores its own theme at boot.
  const initialState = useRef<{ themes: DormouseTheme[]; activeId: string }>(null);
  if (initialState.current === null) {
    const restored = restoreActiveTheme(defaultThemeId);
    const themes = getAllThemes();
    initialState.current = { themes, activeId: restored?.id ?? themes[0]?.id ?? '' };
  }
  const [themes, setThemes] = useState(initialState.current.themes);
  const [activeId, setActiveId] = useState(initialState.current.activeId);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [storeOpen, setStoreOpen] = useState(false);
  const [debuggerOpen, setDebuggerOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const [triggerEl, setTriggerEl] = useState<HTMLButtonElement | null>(null);
  const [menuEl, setMenuEl] = useState<HTMLDivElement | null>(null);

  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  const inDialog = variant === 'settings-dialog';
  const activeTheme = themes.find((theme) => theme.id === activeId) ?? themes[0];

  // React Router document hydration can reconcile render-time theme
  // application away; repeat once after commit so xterm sees real colors.
  useBrowserLayoutEffect(() => {
    const theme = restoreActiveTheme(defaultThemeId);
    if (theme) setActiveId(theme.id);
  }, [defaultThemeId]);

  const closeDropdown = useCallback(() => setOpen(false), [setOpen]);
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

  // Anchor the dialog menu off the measured trigger rect: the Settings dialog
  // surface is `overflow-y-auto`, which would clip an absolutely-positioned
  // menu. A fixed descendant escapes ancestor overflow because no modal
  // ancestor sets `transform`. The menu's own rect feeds the viewport clamp, so
  // a long theme list can't run off the bottom of a short window; it is 0 on
  // the first pass, which is why the menu stays hidden until measured. The
  // panel itself is viewport-bounded; its flexing theme list scrolls while the
  // footer actions stay visible.
  const triggerRect = useMeasuredElementRect(inDialog && open ? triggerEl : null);
  const menuRect = useMeasuredElementRect(inDialog && open ? menuEl : null);
  const viewportBoundedPanelStyle: CSSProperties = {
    ...styles.panel,
    maxHeight: MENU_MAX_HEIGHT,
  };
  const menuStyle: CSSProperties = inDialog
    ? {
        ...viewportBoundedPanelStyle,
        width: MENU_WIDTH_PX,
        ...(triggerRect
          ? clampOverlayPosition({
              left: triggerRect.left,
              top: triggerRect.top + triggerRect.height + 4,
              width: MENU_WIDTH_PX,
              height: menuRect?.height ?? 0,
            })
          : { position: 'fixed', visibility: 'hidden' }),
      }
    : viewportBoundedPanelStyle;

  return (
    <div ref={rootRef} className="relative flex items-center">
      <button
        ref={setTriggerEl}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Theme: ${activeTheme?.label ?? 'Select theme'}`}
        onClick={() => setOpen(!open)}
        className={chromeButton({ kind: 'labeled' })}
      >
        <span className="min-w-0 truncate">
          {inDialog ? (activeTheme?.label ?? 'Select theme') : 'Theme'}
        </span>
        <CaretDownIcon size={10} weight="bold" className="shrink-0 opacity-65" aria-hidden="true" />
      </button>

      {/* z-50 earns its keep in both variants. Inside the dialog the alarm
          sections' `opacity-50` wrappers are stacking contexts too, and being
          later in tree order they would otherwise paint through this menu. */}
      {open ? (
        <div
          ref={setMenuEl}
          role="menu"
          aria-label="Select theme"
          className={`z-50 flex flex-col overflow-hidden rounded border font-mono shadow-2xl ${
            inDialog ? '' : 'absolute right-0 top-full mt-1 w-[280px]'
          }`}
          style={menuStyle}
        >
          <div className="min-h-0 overflow-y-auto py-1" style={{ maxHeight: 320 }}>
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
                    className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-sm"
                    style={{ color: 'inherit' }}
                  >
                    <ThemeSwatch theme={theme} />
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

          <div className="shrink-0 border-t p-1" style={styles.border}>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setDebuggerOpen(true);
              }}
              className="w-full rounded px-3 py-1.5 text-left text-sm font-medium transition-opacity hover:opacity-85"
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
              className="w-full rounded px-3 py-1.5 text-left text-sm font-medium transition-opacity hover:opacity-85"
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
