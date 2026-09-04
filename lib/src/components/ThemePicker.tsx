import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CaretDownIcon, XIcon } from '@phosphor-icons/react';
import type { DormouseTheme } from '../lib/themes';
import {
  applyTheme,
  getAllThemes,
  getBundledThemes,
  getTheme,
  removeInstalledTheme,
  restoreActiveTheme,
  setActiveThemeId,
} from '../lib/themes';
import { ThemeDebuggerDialog } from './ThemeDebugger';
import { ThemeSwatch } from './theme-picker/ThemeSwatch';
import { ThemeStoreDialog } from './theme-picker/ThemeStoreDialog';
import { useAnchoredMenu, useCloseOnOutsideAndEscape } from './use-anchored-menu';
import { themePickerStyles as styles } from './theme-picker/styles';
import { chromeButton, modalIconButton, OVERLAY_MAX_HEIGHT } from './design';

/**
 * `compact` is the free-floating trigger used by the website's Pocket
 * playground pages, which have no baseboard and therefore no Settings dialog.
 * `settings-dialog` is the row inside the Settings dialog, which is where every
 * host with a baseboard sets its theme (docs/specs/theme.md).
 */
export type ThemePickerVariant = 'compact' | 'settings-dialog';

/** Which way `compact` opens its menu. Ignored by `settings-dialog`, which
 *  anchors off its measured trigger rect instead. */
export type ThemePickerMenuSide = 'below' | 'above';

export interface ThemePickerProps {
  variant: ThemePickerVariant;
  /** Controlled dropdown state. Omit both for the uncontrolled default; the
   *  Settings dialog controls them so its `onEscape` can close the menu before
   *  the dialog itself (`ModalFrame`'s capture-phase Escape handler would
   *  otherwise swallow the key before the picker ever sees it). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Default `below`. A `compact` trigger pinned to the bottom of the viewport
   *  needs `above`, or its menu opens off-screen. */
  menuSide?: ThemePickerMenuSide;
  /**
   * The user chose a theme from this picker.
   *
   * Fires on every selection, including re-selecting the active one — unlike
   * `subscribeToActiveTheme`, which reports a changed id. A caller asking
   * "has this person picked a theme yet" needs the choice, not the change:
   * `restoreActiveTheme` persists an id of its own, so storage cannot answer
   * it (docs/specs/theme.md).
   */
  onPick?: (theme: DormouseTheme) => void;
}

const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Menu width. Mirrored by the `w-[280px]` literal on the non-dialog variant,
 *  which Tailwind must be able to scan statically. */
const MENU_WIDTH_PX = 280;

export function ThemePicker({
  variant,
  open: controlledOpen,
  onOpenChange,
  menuSide = 'below',
  onPick,
}: ThemePickerProps) {
  // The server and first client render must agree. Installed themes and the
  // active id come from browser storage, so reading either here leaves React
  // with an attribute mismatch it deliberately will not patch during hydration.
  const initialState = useRef<{ themes: DormouseTheme[]; activeId: string }>(null);
  if (initialState.current === null) {
    const themes = getBundledThemes();
    initialState.current = { themes, activeId: themes[0]?.id ?? '' };
  }
  const [themes, setThemes] = useState(initialState.current.themes);
  const [activeId, setActiveId] = useState(initialState.current.activeId);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [storeOpen, setStoreOpen] = useState(false);
  const [debuggerOpen, setDebuggerOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  const { setTriggerEl, setMenuEl, menuStyle } = useAnchoredMenu(open, MENU_WIDTH_PX, {
    side: inDialog ? 'below' : menuSide,
    align: inDialog ? 'start' : 'end',
  });

  // Hosts restore the visible body theme at boot. The picker separately
  // reconciles its stored rows and selected value after hydration so its first
  // markup stays deterministic without leaving its label or swatch stale.
  useBrowserLayoutEffect(() => {
    const theme = restoreActiveTheme();
    setThemes(getAllThemes());
    if (theme) setActiveId(theme.id);
  }, []);

  const closeDropdown = useCallback(() => setOpen(false), [setOpen]);
  useCloseOnOutsideAndEscape(open, rootRef, closeDropdown);

  const refreshThemes = useCallback(() => {
    setThemes(getAllThemes());
    const theme = restoreActiveTheme();
    if (theme) setActiveId(theme.id);
  }, []);

  const selectTheme = (id: string) => {
    const theme = getTheme(id);
    if (!theme) return;
    setActiveThemeId(id);
    setActiveId(id);
    applyTheme(theme);
    setOpen(false);
    onPick?.(theme);
  };

  const deleteTheme = (theme: DormouseTheme) => {
    if (theme.origin.kind !== 'installed') return;
    removeInstalledTheme(theme.id);
    // Re-resolves the active theme through the host default, which is what
    // uninstalling the *active* theme needs; a no-op re-apply otherwise.
    refreshThemes();
  };

  // Critical geometry is inline and owned by the component. The docs website
  // consumes raw library JSX without the lib stylesheet, so utility classes
  // alone cannot carry the viewport cap, stacking, or flex-shrink contract.
  // Compact stays absolute to its trigger: a fixed descendant of the docs'
  // sticky mobile bar is offset by that containing block in Chromium.
  const compactMenuStyle = {
    width: menuStyle.width,
    zIndex: menuStyle.zIndex,
    maxHeight: menuStyle.maxHeight,
    position: 'absolute',
    right: 0,
    ...(menuSide === 'above'
      ? { bottom: 'calc(100% + 4px)' }
      : { top: 'calc(100% + 4px)' }),
  } satisfies React.CSSProperties;
  const panelStyle = {
    ...styles.panel,
    ...(inDialog ? menuStyle : compactMenuStyle),
  };

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
        style={inDialog ? undefined : styles.compactTrigger}
      >
        {activeTheme ? <ThemeSwatch theme={activeTheme} /> : null}
        <span className="min-w-0 truncate">
          {inDialog ? (activeTheme?.label ?? 'Select theme') : 'Theme'}
        </span>
        <CaretDownIcon size={10} weight="bold" className="shrink-0 opacity-65" aria-hidden="true" />
      </button>

      {/* The class is a harmless fallback; inline geometry owns the panel in
          hosts that do not compile the library's utilities. */}
      {open ? (
        <div
          ref={setMenuEl}
          role="menu"
          aria-label="Select theme"
          className={`z-50 flex flex-col overflow-hidden rounded border font-mono shadow-2xl ${OVERLAY_MAX_HEIGHT.popover}`}
          style={panelStyle}
        >
          {/* max-h-80 is a ceiling on a tall screen, never a floor: the
              panel's own viewport cap shrinks this further on a short one. */}
          <div className="max-h-80 min-h-0 flex-1 overflow-y-auto py-1" style={styles.list}>
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
                    className={`flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-3 text-left text-sm ${
                      isInstalled ? 'pr-1' : 'pr-3'
                    }`}
                    style={{ color: 'inherit' }}
                  >
                    <ThemeSwatch theme={theme} />
                    <span className="min-w-0 flex-1 truncate">{theme.label}</span>
                  </button>
                  {isInstalled ? (
                    <button
                      type="button"
                      aria-label={`Uninstall ${theme.label}`}
                      title={`Uninstall ${theme.label}`}
                      // Bigger target and a gap from the row's select action:
                      // unlike `WatchedCommandList`'s remove, undoing this
                      // means re-finding the extension on OpenVSX.
                      className={modalIconButton({ class: 'mr-2 ml-1 p-1.5' })}
                      style={{ color: 'inherit' }}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        deleteTheme(theme);
                      }}
                    >
                      <XIcon size={12} weight="bold" />
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>

          <div className="shrink-0 border-t p-1" style={{ ...styles.border, ...styles.footer }}>
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
