/**
 * Whether this page runs as an installed web app rather than in a browser tab
 * (`docs/specs/pocket-app.md` → Detecting install state, and what cannot be
 * detected). Its own module so a page that only names the mode — the label a
 * phone suggests at pairing — carries none of the push machinery.
 */
export function isInstalledWebApp(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  if (nav.standalone === true) return true;
  return globalThis.matchMedia?.('(display-mode: standalone)').matches ?? false;
}
