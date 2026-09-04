/**
 * A setup password of the only shape the Server accepts, which
 * `HEX_ENCODED_32_BYTES_PATTERN` in `server-lib-common` defines
 * (`docs/specs/server.md` → Configuration). Deterministic, not random: every
 * test and story in this package takes it from here.
 */
export const TEST_SETUP_PASSWORD = '0123456789abcdef'.repeat(4);
