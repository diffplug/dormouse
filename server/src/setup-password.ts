import { HEX_ENCODED_32_BYTES_PATTERN } from 'server-lib-common';

/** 32 random bytes encoded as lowercase hexadecimal. */
export const SETUP_PASSWORD_PATTERN = HEX_ENCODED_32_BYTES_PATTERN;

/** Whether a value has the only setup-password shape the Server accepts. */
export function isSetupPassword(value: unknown): value is string {
  return typeof value === 'string' && SETUP_PASSWORD_PATTERN.test(value);
}
