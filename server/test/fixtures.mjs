/**
 * Pure test constants, in a module with no imports so the suites that must stay
 * independent of `helpers.mjs` (the config mapping, the spawned entrypoint) can
 * share them too.
 */

export const ORIGIN = 'http://localhost:3000';
export const RP_ID = 'localhost';

/**
 * A setup password of the only shape `readConfig` and `createApp` accept: 64
 * lowercase hex characters. Deterministic, not random — every suite that needs
 * one takes it from here so a change to that shape is a single edit.
 */
export const PASSWORD = '0123456789abcdef'.repeat(4);
