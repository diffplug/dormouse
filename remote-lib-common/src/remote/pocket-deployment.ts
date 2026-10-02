/**
 * How one Pocket bundle learns that Hosted serves it
 * (`docs/specs/remote-network.md` -> "Anywhere"): Hosted's relay staging
 * (`hosted/scripts/stage-relay.mjs`) writes {@link HOSTED_POCKET_DEPLOYMENT} as
 * JSON to {@link POCKET_DEPLOYMENT_FILE} beside it, and Pocket
 * (`lib/src/remote/pocket-app/deployment.ts`) reads it back. **Never in a
 * Pocket build**, which a self-host Relay serves as it is.
 *
 * Imports nothing, so the staging script loads this file as source.
 */

/** The file beside Pocket's shell, at the root of the origin that serves it. */
export const POCKET_DEPLOYMENT_FILE = 'deployment.json';

/** What {@link POCKET_DEPLOYMENT_FILE} holds where Hosted serves Pocket. */
export const HOSTED_POCKET_DEPLOYMENT = { deployment: 'hosted' } as const;
