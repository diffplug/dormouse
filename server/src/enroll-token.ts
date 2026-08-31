/**
 * The installer's one-time enroll token: read, compared, and spent
 * (`docs/specs/server.md` → "Configuration" → `DORMOUSE_ENROLL_TOKEN_FILE`).
 */

import { readFile, unlink } from 'node:fs/promises';

import { isEnrollmentOffer } from 'server-lib-common';
import type { EnrollmentOffer } from 'server-lib-common';

import { secretEquals } from './secrets.js';

/**
 * The installer's enrollment offer, or `null` for every way it can fail to be
 * one — absent, unreadable, not JSON, wrong shape.
 */
async function readEnrollmentOffer(path: string): Promise<EnrollmentOffer | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isEnrollmentOffer(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Spend the offer at `path` on `supplied`; an unconfigured path rejects. */
export async function redeemEnrollToken(
  path: string | null | undefined,
  supplied: string,
): Promise<'redeemed' | 'rejected' | 'not-invalidated'> {
  if (!path) return 'rejected';
  // Read per attempt, never cached at boot: the installer rewrites this file
  // on every upgrade, and a redemption deletes it.
  const offer = await readEnrollmentOffer(path);
  // Only the token is compared. The offer's `origin` is for the Host-side
  // reader — this server wrote the file, so checking it here proves nothing.
  if (offer === null || !secretEquals(supplied, offer.token)) return 'rejected';
  // Invalidate before enrolling: a token that cannot be deleted must not be
  // redeemable, or a failed unlink leaves a single-use secret usable forever.
  try {
    await unlink(path);
  } catch {
    return 'not-invalidated';
  }
  return 'redeemed';
}
