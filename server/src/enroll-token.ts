/**
 * The installer's one-time enroll token: read, compared, and spent
 * (`docs/specs/server.md` → "Configuration" → `DORMOUSE_ENROLL_TOKEN_FILE`).
 */

import { readFile, unlink } from 'node:fs/promises';

import { ENROLL_TOKEN_PATTERN, parseEnrollmentOffer } from 'server-lib-common';
import type { EnrollmentOffer } from 'server-lib-common';

import { secretEquals } from './secrets.js';

/** How long an offer stays redeemable; the installer mints a fresh one per run. */
const ENROLL_OFFER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function errnoOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

/**
 * The installer's enrollment offer, or `null` for every way it can fail to be
 * one — absent, unreadable, not JSON, wrong shape. An absent file is the normal
 * spent state and stays silent; a file that exists and cannot be used is an
 * install the operator has to repair, and this warn is its only trace.
 */
async function readEnrollmentOffer(path: string): Promise<EnrollmentOffer | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (errnoOf(err) !== 'ENOENT') warnUnusable(path);
    return null;
  }
  // The parse itself is shared with the Host-side reader of the same file
  // (`server-lib-common/src/remote/enroll-offer.ts`); the warn is this side's.
  const offer = parseEnrollmentOffer(text);
  if (offer === null) warnUnusable(path);
  return offer;
}

function warnUnusable(path: string): void {
  console.warn(
    `enrollment offer at ${path} could not be read as an offer; one-click ` +
      `enrollment is off until the installer mints a new one`,
  );
}

/** A stamp that will not parse, or is a week old, is no longer redeemable. */
function isFresh(mintedAt: string): boolean {
  const minted = Date.parse(mintedAt);
  if (Number.isNaN(minted)) return false;
  // A future stamp passes: one machine writes and reads this file, so clock
  // skew is not evidence of anything and must not brick the one-click path.
  return Date.now() - minted <= ENROLL_OFFER_MAX_AGE_MS;
}

/** Spend the offer at `path` on `supplied`; an unconfigured path rejects. */
export async function redeemEnrollToken(
  path: string | null | undefined,
  supplied: string,
): Promise<'redeemed' | 'rejected' | 'not-invalidated'> {
  if (!path) return 'rejected';
  // The format is public (server.md → "Configuration"), so refusing a malformed
  // token before the read leaks nothing and spares a disk read per attempt
  // under a flood of junk.
  if (!ENROLL_TOKEN_PATTERN.test(supplied)) return 'rejected';
  // Read per attempt, never cached at boot: the installer rewrites this file
  // on every upgrade, and a redemption deletes it.
  const offer = await readEnrollmentOffer(path);
  // Only the token is compared. Whoever can write this file chooses every
  // field, so checking the offer's `origin` here would authorize nothing — it
  // is for the Host-side reader (`lib/src/host/remote/enroll-offer.ts`), which
  // uses it to name the server it is about to enroll against.
  if (offer === null || !isFresh(offer.mintedAt) || !secretEquals(supplied, offer.token)) {
    return 'rejected';
  }
  // Invalidate before enrolling: a token that cannot be deleted must not be
  // redeemable, or a failed unlink leaves a single-use secret usable forever.
  // An installer rerun between the read and this unlink would have its fresh
  // offer deleted here; accepted, because the writer is an interactive
  // same-machine installer run that can simply be run again.
  try {
    await unlink(path);
  } catch (err) {
    // ENOENT means someone else spent (or rewrote) the file first: this attempt
    // lost the race, which is an ordinary rejection. `not-invalidated` — the
    // 500 that says the install is broken — is for a real failure to delete.
    return errnoOf(err) === 'ENOENT' ? 'rejected' : 'not-invalidated';
  }
  return 'redeemed';
}
