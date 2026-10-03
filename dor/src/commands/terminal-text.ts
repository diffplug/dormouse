// Browser-safe: the website playground runs the picker that imports these.
const TERMINAL_CONTROLS = /[\x00-\x1f\x7f-\x9f]/g;
export const escapeControl = (char: string) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;

/** Repo text relayed by the host, bound for a terminal: C0, DEL, and C1
 *  controls become `\u` escapes, so the text cannot drive the terminal. */
export function printable(text: string): string {
  return text.replace(TERMINAL_CONTROLS, escapeControl);
}

/** The same controls removed rather than escaped. */
export function stripControls(text: string): string {
  return text.replace(TERMINAL_CONTROLS, '');
}
