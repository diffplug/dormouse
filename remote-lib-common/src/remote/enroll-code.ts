/**
 * The user code of Hosted's device-code Burrow enrollment
 * (`docs/specs/hosted.md` -> "Burrow enrollment"): what Dormouse shows, what the
 * account page shows beside Approve, and what the user compares between them.
 *
 * Imports nothing, so the account frontend takes it without the rest of this
 * package.
 */

/**
 * Crockford base32 without `0`, `1` (nor the `O`, `I`, `L`, `U` Crockford
 * already drops): thirty characters no one reads as another.
 */
export const ENROLL_USER_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Characters in a user code, split in two halves of four. */
export const ENROLL_USER_CODE_CHARACTERS = 8;

const USER_CODE = /^[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/;

/** Whether `value` is a user code in its displayed shape, `XXXX-XXXX`. */
export function isEnrollUserCode(value: unknown): value is string {
  return typeof value === 'string' && USER_CODE.test(value);
}

/**
 * `text` as a displayed user code — case, spaces, and dashes are forgiven, as a
 * person retyping it would vary them — or `null` when it is no user code.
 */
export function normalizeEnrollUserCode(text: unknown): string | null {
  if (typeof text !== 'string' || text.length > 32) return null;
  const bare = text.toUpperCase().replace(/[\s-]/g, '');
  const code = `${bare.slice(0, 4)}-${bare.slice(4)}`;
  return isEnrollUserCode(code) ? code : null;
}
