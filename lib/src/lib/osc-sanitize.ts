/**
 * The shared sanitizer for untrusted OSC payload text — OSC 9/99/777
 * notifications, the OSC 367 tool announcement, and the shell-reported command
 * line, all arbitrary process output that reaches UI (`docs/specs/alert.md` ->
 * notification protocols, `docs/specs/terminal-escapes.md`).
 */

/** Clamp by code point, so a truncation cannot split a surrogate pair. */
export function truncateText(input: string, limit: number): string {
  if (input.length <= limit) return input;
  return Array.from(input).slice(0, limit).join('');
}

/** Collapse control characters and runs of whitespace, trim, then clamp.
 *  Returns null when nothing survives. */
export function sanitizeText(input: string, limit: number): string | null {
  const collapsed = input
    .replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!collapsed) return null;
  return truncateText(collapsed, limit);
}

/** {@link sanitizeText} for a shell command line, which keeps its line breaks:
 *  a whitespace run holding one (`\r\n` and `\r` included) collapses to `\n`,
 *  since an unquoted newline separates commands the way `;` does. */
export function sanitizeCommandLine(input: string, limit: number): string | null {
  const collapsed = input
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]+/g, ' ')
    .replace(/\s+/g, (run) => (run.includes('\n') ? '\n' : ' '))
    .trim();
  if (!collapsed) return null;
  return truncateText(collapsed, limit);
}
