import { HEX_ENCODED_32_BYTES_PATTERN } from 'server-lib-common';

/** Whether a value has the only setup-password shape the Server accepts:
 * 32 random bytes encoded as lowercase hexadecimal. */
export function isSetupPassword(value: unknown): value is string {
  return typeof value === 'string' && HEX_ENCODED_32_BYTES_PATTERN.test(value);
}
