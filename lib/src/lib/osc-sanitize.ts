/**
 * The shared sanitizer for untrusted OSC payload text
 * (`docs/specs/alert.md` -> notification protocols).
 *
 * Its own module so every payload reader answers to one rule: OSC 9/99/777
 * carry notification text and OSC 367 carries a tool's self-description, all of
 * it arbitrary process output that reaches UI.
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
