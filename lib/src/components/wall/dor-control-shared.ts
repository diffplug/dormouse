/**
 * The two conversions every side of the `dor` control plane makes: an
 * unvalidated wire param read as a string, and any thrown failure read as the
 * text a response carries. Shared by the Wall's handler, the Window-level
 * router, and the `workspace.*` handlers, so a request answers the same way
 * whichever of them answers it (`docs/specs/dor-cli.md` → "Handle Model").
 */

/** A param as it crossed the control socket: whatever is not a string is absent. */
export function stringParam(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** The message a failed response carries, from a throw or a rejection. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
