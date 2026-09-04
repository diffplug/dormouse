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
import { chromeButton, modalIconButton, OVERLAY_MAX_HEIGHT, POPUP_SURFACE_CLASS } from './design';

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

/** Menu width, applied inline by `useAnchoredMenu` for both variants. */
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
  // `getBundledThemes` is the same module array every call, so both initializers
  // are stable without a ref to latch them.
  const [themes, setThemes] = useState(getBundledThemes);
  const [activeId, setActiveId] = useState(() => themes[0]?.id ?? '');
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

  // `compact` stays absolute to its trigger: a fixed descendant of the docs'
  // sticky mobile bar is offset by that containing block in Chromium.
  const { setTriggerEl, setMenuEl, menuStyle } = useAnchoredMenu(
    open,
    MENU_WIDTH_PX,
    inDialog ? undefined : { side: menuSide, align: 'end', strategy: 'absolute' },
  );

  const closeDropdown = useCallback(() => setOpen(false), [setOpen]);
  useCloseOnOutsideAndEscape(open, rootRef, closeDropdown);

  const refreshThemes = useCallback(() => {
    setThemes(getAllThemes());
    const theme = restoreActiveTheme();
    if (theme) setActiveId(theme.id);
  }, []);

  // Hosts restore the visible body theme at boot. The picker separately
  // reconciles its stored rows and selected value after hydration so its first
  // markup stays deterministic without leaving its label or swatch stale.
  useBrowserLayoutEffect(refreshThemes, [refreshThemes]);

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

  return (
    <div ref={rootRef} className="relative flex items-center">
      <button
        ref={setTriggerEl}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Theme: ${activeTheme?.label ?? 'Select theme'}`}
        onClick={() => setOpen(!open)}
        // The compact trigger stands alone on a touch surface, so it takes the
        // 44px minimum the dialog row inherits from the dialog around it.
        className={`${chromeButton({ kind: 'labeled' })} ${inDialog ? '' : 'min-h-11 min-w-11'}`}
      >
        {activeTheme ? <ThemeSwatch theme={activeTheme} /> : null}
        <span className="min-w-0 truncate">
          {inDialog ? (activeTheme?.label ?? 'Select theme') : 'Theme'}
        </span>
        <CaretDownIcon size={10} weight="bold" className="shrink-0 opacity-65" aria-hidden="true" />
      </button>

      {/* `OVERLAY_MAX_HEIGHT.popover` is the cap for the frame before the
          trigger has been measured; `menuStyle` narrows it to the space
          actually left beside the trigger from then on. */}
      {open ? (
        <div
          ref={setMenuEl}
          role="menu"
          aria-label="Select theme"
          className={`${POPUP_SURFACE_CLASS} flex flex-col overflow-hidden ${OVERLAY_MAX_HEIGHT.popover}`}
          style={menuStyle}
        >
          {/* max-h-80 is a ceiling on a tall screen, never a floor: the panel's
              own viewport cap shrinks this further on a short one. */}
          <div className="max-h-80 min-h-0 flex-1 overflow-y-auto py-1">
            {themes.map((theme) => {
              const isActive = theme.id === activeId;
              const isInstalled = theme.origin.kind === 'installed';
              return (
                <div
                  key={theme.id}
                  className={`flex items-center transition-colors ${
                    isActive
                      ? 'bg-header-active-bg text-header-active-fg'
                      : 'text-foreground'
                  }`}
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

          <div className="shrink-0 border-t border-border p-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setDebuggerOpen(true);
              }}
              className="w-full rounded px-3 py-1.5 text-left text-sm font-medium text-foreground transition-opacity hover:opacity-85"
            >
              Debug current theme
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setStoreOpen(true);
              }}
              className="w-full rounded px-3 py-1.5 text-left text-sm font-medium text-link transition-opacity hover:opacity-85"
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
