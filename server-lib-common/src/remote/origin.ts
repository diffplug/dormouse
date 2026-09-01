/**
 * One reduction of a URL to a bare scheme-host-port, for the three places that
 * need one: the Server's `DORMOUSE_ORIGIN` (`server/src/config.ts`), the
 * `origin` a Host reads back off an enrollment response
 * (`lib/src/remote/host/enrollment.ts`), and the offer file's own field
 * ({@link isEnrollmentOffer}).
 */

/**
 * `value` as a bare origin, or `null` when it is not an absolute URL with a
 * host. `URL.origin` is the string `'null'` for a scheme that has none — a
 * `mailto:`, a bare `file:` — which every compare downstream would then run
 * against, so it is rejected here rather than returned.
 */
export function normalizeOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const { origin } = new URL(value);
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/** True for a value that is already bare — what {@link normalizeOrigin} yields. */
export function isOrigin(value: unknown): boolean {
  return normalizeOrigin(value) === value;
}
