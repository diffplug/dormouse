import { useCallback, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { CaretDownIcon, CheckIcon } from '@phosphor-icons/react';
import {
  getShellsSnapshot,
  selectShell,
  subscribeToShells,
} from '../lib/shell-store';
import { useCloseOnOutsideAndEscape } from './theme-picker/use-close-on-outside';
import { chromeButton, OVERLAY_MAX_HEIGHT, PopupButtonRow, useMeasuredElementRect } from './design';
import { clampOverlayPosition } from '../lib/ui-geometry';

/** Menu width. A shell name is a basename, so this is generous; the clamp below
 *  needs a number, not `w-max`. */
const MENU_WIDTH_PX = 200;

export interface ShellPickerProps {
  /** Controlled, so the Settings dialog's `onEscape` can close this menu before
   *  the dialog itself (`ModalFrame`'s capture-phase Escape handler would
   *  otherwise swallow the key before the picker ever sees it). */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The Settings dialog's Shell row: pick which detected shell new terminals
 * spawn with (`lib/src/lib/shell-store.ts`). Choosing one swaps an untouched
 * pane in place — the store owns that dispatch, this is only the trigger.
 *
 * Renders nothing when no shells were detected. The dialog also hides the row
 * below two shells and on hosts that own shell selection, so this is
 * belt-and-braces for a direct render.
 */
export function ShellPicker({ open, onOpenChange }: ShellPickerProps) {
  const { shells, selected } = useSyncExternalStore(subscribeToShells, getShellsSnapshot);
  const rootRef = useRef<HTMLDivElement>(null);
  const [triggerEl, setTriggerEl] = useState<HTMLButtonElement | null>(null);
  const [menuEl, setMenuEl] = useState<HTMLDivElement | null>(null);

  const closeMenu = useCallback(() => onOpenChange(false), [onOpenChange]);
  useCloseOnOutsideAndEscape(open, rootRef, closeMenu);

  // Anchor off the measured trigger rect, exactly as `ThemePicker` does: the
  // Settings dialog surface is `overflow-y-auto` and would clip an absolutely
  // positioned menu, while a fixed descendant escapes that overflow. The menu's
  // own rect feeds the viewport clamp, and is 0 on the first pass — which is
  // why the menu stays hidden until it has been measured.
  const triggerRect = useMeasuredElementRect(open ? triggerEl : null);
  const menuRect = useMeasuredElementRect(open ? menuEl : null);
  const menuStyle: CSSProperties = {
    width: MENU_WIDTH_PX,
    ...(triggerRect
      ? clampOverlayPosition({
          left: triggerRect.left,
          top: triggerRect.top + triggerRect.height + 4,
          width: MENU_WIDTH_PX,
          height: menuRect?.height ?? 0,
        })
      : { position: 'fixed', visibility: 'hidden' }),
  };

  if (shells.length === 0) return null;

  return (
    <div ref={rootRef} className="relative flex items-center">
      <button
        ref={setTriggerEl}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Shell: ${selected?.name ?? 'Select shell'}`}
        onClick={() => onOpenChange(!open)}
        className={chromeButton({ kind: 'labeled' })}
      >
        <span className="min-w-0 truncate">{selected?.name ?? 'Select shell'}</span>
        <CaretDownIcon size={10} weight="bold" className="shrink-0 opacity-65" aria-hidden="true" />
      </button>

      {/* z-50 for the same reason as `ThemePicker`'s: the alarm sections'
          `opacity-50` wrappers below are stacking contexts, and being later in
          tree order they would otherwise paint through this menu. */}
      {open ? (
        <div ref={setMenuEl} className="z-50" style={menuStyle}>
          {/* `PopupButtonRow` takes no ref, so the fixed positioning and the
              measured rect live on the wrapper above it. */}
          <PopupButtonRow
            role="menu"
            aria-label="Select shell"
            className={`w-full flex-col ${OVERLAY_MAX_HEIGHT.popover}`}
          >
            <div className="min-h-0 flex-1 overflow-y-auto py-1">
              {shells.map((shell) => {
                const isSelected = shell.path === selected?.path;
                return (
                  <button
                    key={shell.path}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isSelected}
                    className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-foreground/10"
                    onClick={() => {
                      selectShell(shell);
                      onOpenChange(false);
                    }}
                  >
                    {/* Fixed-width slot so the names line up whether or not the
                        row is the selected one. */}
                    <span className="flex w-3.5 shrink-0 items-center justify-center">
                      {isSelected ? <CheckIcon size={12} weight="bold" /> : null}
                    </span>
                    <span className="min-w-0 truncate">{shell.name}</span>
                  </button>
                );
              })}
            </div>
          </PopupButtonRow>
        </div>
      ) : null}
    </div>
  );
}
