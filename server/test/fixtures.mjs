/**
 * Pure test constants, in a module with no imports so the suites that must stay
 * independent of `helpers.mjs` (the config mapping, the spawned entrypoint) can
 * share them too.
 */

export const ORIGIN = 'http://localhost:3000';
export const RP_ID = 'localhost';

/**
 * A setup password of the only shape `createApp` accepts, which
 * `HEX_ENCODED_32_BYTES_PATTERN` in `remote-lib-common` defines. Tests inject
 * it below the production entrypoint; production mints its own. Deterministic,
 * not random: every suite in this package takes it from here.
 */
export const PASSWORD = '0123456789abcdef'.repeat(4);
