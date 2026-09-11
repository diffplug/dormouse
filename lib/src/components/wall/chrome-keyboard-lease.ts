import { createDialogKeyboardCoordinator, type AcquireDialogKeyboard } from './wall-context';

/**
 * Command-mode keyboard suppression for chrome that lives OUTSIDE every Wall —
 * today the Workspace strip's rename editor and close confirmation, which sit in
 * the AppBar (`docs/specs/layout.md` → "Keyboard shortcuts (command mode)").
 * The Wall's dispatch listener is capture-phase on `window`, so a field up there
 * cannot stop it with `stopPropagation`; it takes a lease instead.
 *
 * One window-wide flag, reference-counted by the same coordinator a Wall uses for
 * its own dialogs, so overlapping holders each release only their own.
 */
const held = { current: false };
let coordinator = createDialogKeyboardCoordinator(held);

/** Take one lease; the returned release drops it (idempotent). Stable identity,
 *  so `useDialogKeyboardOwner` can hold it in a dependency list. */
export const acquireChromeKeyboardLease: AcquireDialogKeyboard = () => coordinator();

export function chromeKeyboardHeld(): boolean {
  return held.current;
}

/** Drop every lease (tests). The coordinator is replaced rather than zeroed, so a
 *  release still outstanding cannot resurrect the flag. */
export function resetChromeKeyboardLeases(): void {
  coordinator = createDialogKeyboardCoordinator(held);
  held.current = false;
}
