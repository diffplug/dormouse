/**
 * What every side of the `dor` control plane shares: an unvalidated wire param
 * read as a string, any thrown failure read as the text a response carries, and
 * the registration-gap retry a Wall that has not registered yet is given.
 * Used by the Wall's handler, the Window-level router, and the `workspace.*`
 * handlers, so a request answers the same way whichever of them answers it
 * (`docs/specs/dor-cli.md` → "Handle Model").
 */

import { getWallHandle, type WallHandle } from './wall-handles';
import type { WorkspaceId } from '../../lib/session-types';

/** A param as it crossed the control socket: whatever is not a string is absent. */
export function stringParam(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** The message a failed response carries, from a throw or a rejection. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * How many macrotasks a request waits for a Wall to appear. A Wall registers its
 * handle in a passive effect, so a request landing between `createWorkspace()`
 * and that effect — `dor workspace new && dor split`, the strip's `+` under a
 * scripted caller — finds nothing to route to. Retrying is what answers it
 * instead of dropping it; the bound keeps a Window with no Walls at all (a
 * Storybook strip) from retrying forever.
 */
export const ROUTE_RETRIES = 5;

/** What a Workspace whose Wall is still registering answers with, rather than
 *  being treated as a Workspace this Window does not have. */
export function mountingRefusal(ref: string): string {
  return `workspace '${ref}' is still mounting`;
}

/**
 * This Workspace's Wall, waiting out the registration gap the router waits out
 * (`ROUTE_RETRIES` macrotasks), or null once it is clear nothing will register.
 * The Window's own handlers use it wherever a missing Wall is an error rather
 * than a route to retry.
 */
export async function awaitWallHandle(id: WorkspaceId): Promise<WallHandle | null> {
  for (let attempt = 0; attempt < ROUTE_RETRIES; attempt += 1) {
    const handle = getWallHandle(id);
    if (handle) return handle;
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  }
  return getWallHandle(id);
}
