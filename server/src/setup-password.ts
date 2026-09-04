import { randomBytes } from 'node:crypto';

import { HEX_ENCODED_32_BYTES_PATTERN } from 'remote-lib-common';

/** Mint the setup password the Server persists on first boot. */
export function generateSetupPassword(): string {
  return randomBytes(32).toString('hex');
}

/** Whether a value has the only setup-password shape the Server accepts:
 * 32 random bytes encoded as lowercase hexadecimal. */
export function isSetupPassword(value: unknown): value is string {
  return typeof value === 'string' && HEX_ENCODED_32_BYTES_PATTERN.test(value);
}
