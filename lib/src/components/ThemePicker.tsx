import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { CaretDownIcon, XIcon } from '@phosphor-icons/react';
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

export interface ThemePickerProps {
  variant: ThemePickerVariant;
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

export function ThemePicker({
  variant,
  open: controlledOpen,
  onOpenChange,
}: ThemePickerProps) {
  // Apply the persisted theme during render initialization, before commit, so
  // the first paint already has --vscode-* on body. Hosts must not *rely* on
  // this: inside the Settings dialog the picker only mounts once the user opens
  // it, so each host restores its own theme at boot.
  const initialState = useRef<{ themes: DormouseTheme[]; activeId: string }>(null);
  if (initialState.current === null) {
    const restored = restoreActiveTheme();
    const themes = getAllThemes();
    initialState.current = { themes, activeId: restored?.id ?? themes[0]?.id ?? '' };
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

  // Only the dialog variant anchors off its trigger; `compact` floats free and
  // positions itself with the absolute classes below.
  const { setTriggerEl, setMenuEl, menuStyle } = useAnchoredMenu(inDialog && open, MENU_WIDTH_PX);

  // React Router document hydration can reconcile render-time theme
  // application away; repeat once after commit so xterm sees real colors.
  useBrowserLayoutEffect(() => {
    const theme = restoreActiveTheme();
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
  };

  const deleteTheme = (theme: DormouseTheme) => {
    if (theme.origin.kind !== 'installed') return;
    removeInstalledTheme(theme.id);
    // Re-resolves the active theme through the host default, which is what
    // uninstalling the *active* theme needs; a no-op re-apply otherwise.
    refreshThemes();
  };

  const panelStyle: CSSProperties = inDialog ? { ...styles.panel, ...menuStyle } : styles.panel;

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
        {activeTheme ? <ThemeSwatch theme={activeTheme} /> : null}
        <span className="min-w-0 truncate">
          {inDialog ? (activeTheme?.label ?? 'Select theme') : 'Theme'}
        </span>
        <CaretDownIcon size={10} weight="bold" className="shrink-0 opacity-65" aria-hidden="true" />
      </button>

      {/* z-50 earns its keep in both variants — see `useAnchoredMenu` for why
          the dialog one needs it. */}
      {open ? (
        <div
          ref={setMenuEl}
          role="menu"
          aria-label="Select theme"
          className={`z-50 flex flex-col overflow-hidden rounded border font-mono shadow-2xl ${OVERLAY_MAX_HEIGHT.popover} ${
            inDialog ? '' : 'absolute right-0 top-full mt-1 w-[280px]'
          }`}
          style={panelStyle}
        >
          {/* max-h-80 is a ceiling on a tall screen, never a floor: the
              panel's own viewport cap shrinks this further on a short one. */}
          <div className="max-h-80 min-h-0 flex-1 overflow-y-auto py-1">
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
