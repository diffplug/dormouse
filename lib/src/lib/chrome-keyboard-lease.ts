/**
 * Command-mode keyboard suppression for chrome that lives OUTSIDE every Wall —
 * today the Workspace strip's rename editor and close confirmation, which sit in
 * the AppBar (`docs/specs/layout.md` → "Keyboard shortcuts (command mode)").
 * The Wall's dispatch listener is capture-phase on `window`, so a field up there
 * cannot stop it with `stopPropagation`; it takes a lease instead.
 *
 * Reference-counted like `DialogKeyboardContext`, so overlapping holders each
 * release only their own.
 */

let holders = 0;

/** Take one lease; the returned release drops it (idempotent). */
export function acquireChromeKeyboardLease(): () => void {
  holders += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders = Math.max(0, holders - 1);
  };
}

export function chromeKeyboardHeld(): boolean {
  return holders > 0;
}

/** Drop every lease (tests). */
export function resetChromeKeyboardLeases(): void {
  holders = 0;
}
