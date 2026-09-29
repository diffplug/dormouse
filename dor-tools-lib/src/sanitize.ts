/** Shape and text guards for untrusted input: terminal output and posted
 * messages. Dormouse's own OSC readers keep a copy in
 * `lib/src/lib/osc-sanitize.ts`, since this package imports nothing. */

/** A plain object, so arrays and `null` are rejected before any field is read. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Collapse control characters and runs of whitespace, trim, then clamp by
 * code point, so a truncation cannot split a surrogate pair. Returns null when
 * nothing survives. */
export function sanitizeText(input: string, limit: number): string | null {
  const collapsed = input
    .replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!collapsed) return null;
  return collapsed.length <= limit ? collapsed : Array.from(collapsed).slice(0, limit).join('');
}
