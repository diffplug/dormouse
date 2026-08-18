import { useCallback, useRef, useSyncExternalStore } from 'react';
import { CaretDownIcon, CheckIcon } from '@phosphor-icons/react';
import {
  getShellsSnapshot,
  selectShell,
  subscribeToShells,
} from '../lib/shell-store';
import { useAnchoredMenu, useCloseOnOutsideAndEscape } from './use-anchored-menu';
import { chromeButton, OVERLAY_MAX_HEIGHT, PopupButtonRow } from './design';

/** Menu width. A shell name is a basename, so this is generous; the clamp below
 *  needs a number, not `w-max`. */
const MENU_WIDTH_PX = 200;

export interface ShellPickerProps {
  /** Controlled, so the Settings dialog's `onEscape` can close this menu before
   *  the dialog itself (`ModalFrame`'s capture-phase Escape handler would
   *  otherwise swallow the key before the picker ever sees it). */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Dismiss the parent Settings dialog after a choice, before the spawned
   *  terminal takes focus on the next animation frame. */
  onSelect: () => void;
}

/**
 * The Settings dialog's Shell row: pick which detected shell new terminals
 * spawn with (`lib/src/lib/shell-store.ts`). Choosing one swaps an untouched
 * pane in place — the store owns that dispatch, this is only the trigger.
 *
 * The dialog's `showShell` gate is the single owner of whether this row exists
 * at all (too few shells, or a host that owns shell selection).
 */
export function ShellPicker({ open, onOpenChange, onSelect }: ShellPickerProps) {
  const { shells, selected } = useSyncExternalStore(subscribeToShells, getShellsSnapshot);
  const rootRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => onOpenChange(false), [onOpenChange]);
  useCloseOnOutsideAndEscape(open, rootRef, closeMenu);
  const { setTriggerEl, setMenuEl, menuStyle } = useAnchoredMenu(open, MENU_WIDTH_PX);

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

      {open ? (
        <PopupButtonRow
          ref={setMenuEl}
          role="menu"
          aria-label="Select shell"
          className={`flex-col ${OVERLAY_MAX_HEIGHT.popover}`}
          style={menuStyle}
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
                    onOpenChange(false);
                    onSelect();
                    selectShell(shell);
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
      ) : null}
    </div>
  );
}
