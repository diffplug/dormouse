/**
 * A setup password of the only shape the Server accepts: 64 lowercase hex
 * characters (`docs/specs/server.md` → Configuration). Deterministic, not
 * random — shared so a change to that shape is a single edit here.
 */
export const TEST_SETUP_PASSWORD = '0123456789abcdef'.repeat(4);
