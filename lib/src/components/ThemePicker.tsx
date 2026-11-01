import { useCallback, useRef, useState } from 'react';
import { CaretDownIcon } from '@phosphor-icons/react';
import type { DormouseTheme } from '../lib/themes';
import { ThemeDebuggerDialog } from './ThemeDebugger';
import { ThemeList } from './theme-picker/ThemeList';
import { getThemePreview, ThemePreview } from './theme-picker/ThemePreview';
import { ThemeStoreDialog } from './theme-picker/ThemeStoreDialog';
import { useAnchoredMenu, useCloseOnOutsideAndEscape } from './use-anchored-menu';
import { OVERLAY_MAX_HEIGHT, POPUP_SURFACE_CLASS, themePreviewButton } from './design';
import { useThemeChoice } from './theme-picker/use-theme-choice';

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
  /**
   * Offer "Install theme from OpenVSX", which fetches open-vsx.org from the
   * page. Only the website passes it: no network policy governs that fetch,
   * and Standalone's content policy blocks it.
   */
  offerStore?: boolean;
  /** Default true. Offer "Debug current theme" below the list. */
  offerDebugger?: boolean;
  /** Default true. False offers bundled themes only and keeps the pick for
   *  this page alone (`useThemeChoice`). */
  persist?: boolean;
}


/** Menu width, applied inline by `useAnchoredMenu` for both variants. */
const MENU_WIDTH_PX = 280;

export function ThemePicker({
  variant,
  open: controlledOpen,
  onOpenChange,
  menuSide = 'below',
  onPick,
  offerStore = false,
  offerDebugger = true,
  persist = true,
}: ThemePickerProps) {
  const { themes, activeId, select, uninstall, refresh: refreshThemes } = useThemeChoice(persist);
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
  // `themes` is seeded from the non-empty bundled array and only ever grows,
  // so a picker always has an active theme to preview.
  const activeTheme = themes.find((theme) => theme.id === activeId) ?? themes[0]!;
  const preview = getThemePreview(activeTheme);

  // `compact` stays absolute to its trigger: a fixed descendant of the docs'
  // sticky mobile bar is offset by that containing block in Chromium.
  const { setTriggerEl, setMenuEl, menuStyle } = useAnchoredMenu(
    open,
    MENU_WIDTH_PX,
    inDialog ? undefined : { side: menuSide, align: 'end', strategy: 'absolute' },
  );

  const closeDropdown = useCallback(() => setOpen(false), [setOpen]);
  useCloseOnOutsideAndEscape(open, rootRef, closeDropdown);

  const selectTheme = (id: string) => {
    const theme = select(id);
    if (!theme) return;
    setOpen(false);
    onPick?.(theme);
  };

  return (
    <div ref={rootRef} className="relative flex items-center">
      <button
        ref={setTriggerEl}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Theme: ${activeTheme.label}`}
        onClick={() => setOpen(!open)}
        // The compact trigger stands alone on a touch surface, so it takes the
        // 44px minimum on every pointer, not only a coarse one.
        className={`group/theme-preview ${themePreviewButton({ kind: 'trigger' })} ${inDialog ? '' : 'min-h-11 min-w-11'}`}
        style={preview.style}
      >
        <ThemePreview colors={preview.swatch} label={inDialog ? activeTheme.label : 'Theme'} />
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
          <ThemeList
            themes={themes}
            activeId={activeId}
            onSelect={selectTheme}
            onUninstall={uninstall}
          />

          {offerDebugger || offerStore ? (
            <div className="shrink-0 border-t border-border p-1">
              {offerDebugger ? (
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
              ) : null}
              {offerStore ? (
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
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {storeOpen ? (
        <ThemeStoreDialog onClose={() => setStoreOpen(false)} onThemesChanged={refreshThemes} />
      ) : null}
      {debuggerOpen ? <ThemeDebuggerDialog onClose={() => setDebuggerOpen(false)} /> : null}
    </div>
  );
}
