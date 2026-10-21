/**
 * The codes of Hosted's device-code approval (`docs/specs/hosted.md` -> "Burrow
 * enrollment"): the user code, which the link carries to the account page and
 * keys the approval, derived from the device code; and the two confirmation
 * digits Dormouse shows and the user types there, derived from the user code.
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

const CONFIRM_DIGITS = /^[0-9]{2}$/;

/** Whether `value` is two confirmation digits, `00`–`99`. */
export function isEnrollConfirmDigits(value: unknown): value is string {
  return typeof value === 'string' && CONFIRM_DIGITS.test(value);
}

/** The slice of `SubtleCrypto` {@link enrollUserCode} uses. */
interface HmacSubtle {
  importKey(
    format: 'raw',
    keyData: Uint8Array,
    algorithm: { name: 'HMAC'; hash: 'SHA-256' },
    extractable: false,
    keyUsages: readonly ['sign'],
  ): Promise<unknown>;
  sign(algorithm: 'HMAC', key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
}

/**
 * The user code of `deviceCode`: `HMAC-SHA-256(secret, deviceCode)` read five
 * bits at a time, most significant first, into
 * {@link ENROLL_USER_CODE_ALPHABET}, a value past its thirty skipped so every
 * character is equally likely. Without `secret` no one can tell a device
 * code's user code, nor find a device code for a chosen one.
 */
export async function enrollUserCode(
  secret: string,
  deviceCode: Uint8Array,
  subtle: HmacSubtle = (globalThis as unknown as { crypto: { subtle: HmacSubtle } }).crypto.subtle,
): Promise<string> {
  const mac = await hmac(secret, deviceCode, subtle);
  let code = '';
  for (let bit = 0; code.length < ENROLL_USER_CODE_CHARACTERS; bit += 5) {
    // 51 groups for 8 characters: running out has odds below 10^-40, and
    // throwing then beats biasing a character.
    if (bit + 5 > mac.length * 8) throw new Error('No user code in this MAC');
    const byte = bit >> 3;
    const value = (((mac[byte] << 8) | (mac[byte + 1] ?? 0)) >> (11 - (bit & 7))) & 31;
    if (value < ENROLL_USER_CODE_ALPHABET.length) code += ENROLL_USER_CODE_ALPHABET[value];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * The confirmation digits of `userCode`: `HMAC-SHA-256(secret, "confirm:" +
 * userCode)` read sixteen bits at a time, most significant first, a value of
 * 65500 or more skipped so each of the hundred is equally likely. A link
 * carries the user code, never these: without `secret` no one can tell them
 * from it, so only the person who sees Dormouse's screen can type them.
 */
export async function enrollConfirmDigits(
  secret: string,
  userCode: string,
  subtle: HmacSubtle = (globalThis as unknown as { crypto: { subtle: HmacSubtle } }).crypto.subtle,
): Promise<string> {
  const mac = await hmac(secret, new TextEncoder().encode(`confirm:${userCode}`), subtle);
  for (let byte = 0; byte + 1 < mac.length; byte += 2) {
    const value = (mac[byte] << 8) | mac[byte + 1];
    // Sixteen draws: all skipped has odds below 10^-52.
    if (value < 65500) return String(value % 100).padStart(2, '0');
  }
  throw new Error('No confirmation digits in this MAC');
}

async function hmac(secret: string, data: Uint8Array, subtle: HmacSubtle): Promise<Uint8Array> {
  const key = await subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await subtle.sign('HMAC', key, data));
}
