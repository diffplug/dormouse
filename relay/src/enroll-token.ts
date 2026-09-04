/**
 * The installer's one-time enroll token: read, compared, and spent
 * (`docs/specs/relay.md` → "Configuration" → `DORMOUSE_ENROLL_TOKEN_FILE`).
 */

import { randomBytes } from 'node:crypto';
import { link, readFile, rename, unlink } from 'node:fs/promises';

import {
  ENROLL_TOKEN_PATTERN,
  isEnrollmentOfferFresh,
  parseEnrollmentOffer,
} from 'remote-lib-common';
import type { EnrollmentOffer } from 'remote-lib-common';

import { secretEquals } from './secrets.js';

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
  // The parse itself is shared with the Burrow-side reader of the same file
  // (`remote-lib-common/src/remote/enroll-offer.ts`); the warn is this side's.
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

/**
 * Test-only seam. Production callers pass two arguments; the enrollment-offer
 * tests use these callbacks to place installer writes at either side of the
 * claim and prove which generation survives.
 */
type BeforeClaim = () => void | Promise<void>;

/** Spend the offer at `path` on `supplied`; an unconfigured path rejects. */
export async function redeemEnrollToken(
  path: string | null | undefined,
  supplied: string,
  beforeClaim?: BeforeClaim,
  beforeRelease?: BeforeClaim,
): Promise<'redeemed' | 'rejected' | 'not-invalidated'> {
  if (!path) return 'rejected';
  // The format is public (relay.md → "Configuration"), so refusing a malformed
  // token before the read leaks nothing and spares a disk read per attempt
  // under a flood of junk.
  if (!ENROLL_TOKEN_PATTERN.test(supplied)) return 'rejected';
  // Read per attempt, never cached at boot: the installer rewrites this file
  // on every upgrade, and a redemption takes it away.
  const offer = await readEnrollmentOffer(path);
  // Only the token is compared. Whoever can write this file chooses every
  // field, so checking the offer's `origin` here would authorize nothing — it
  // is for the Burrow-side reader (`lib/src/host/remote/enroll-offer.ts`), which
  // uses it to name the Relay it is about to enroll against.
  if (offer === null || !isEnrollmentOfferFresh(offer) || !secretEquals(supplied, offer.token)) {
    return 'rejected';
  }
  await beforeClaim?.();
  return claimOffer(path, offer.token, beforeRelease);
}

/**
 * Remove any offer before a setup-password enrollment becomes the first Burrow.
 * Absence is already the desired state; every other rename failure means the
 * first enrollment must stop rather than leave a second bootstrap credential.
 */
export async function invalidateEnrollOffer(
  path: string | null | undefined,
): Promise<'invalidated' | 'not-invalidated'> {
  if (!path) return 'invalidated';
  const claimPath = `${path}.spent-${randomBytes(6).toString('hex')}`;
  try {
    await rename(path, claimPath);
  } catch (err) {
    return errnoOf(err) === 'ENOENT' ? 'invalidated' : 'not-invalidated';
  }
  // As in redemption, a cleanup failure leaves only an inert `.spent-*` path.
  await unlink(claimPath).catch(() => {});
  return 'invalidated';
}

/**
 * Take the verified offer off the well-known path before anything is enrolled
 * against it, and report whether this attempt is the one that got it.
 */
async function claimOffer(
  path: string,
  verifiedToken: string,
  beforeRelease?: BeforeClaim,
): Promise<'redeemed' | 'rejected' | 'not-invalidated'> {
  // The rename is the single-use gate — not the unlink that follows. Two
  // concurrent unlinks of one path can *both* report success (APFS does), so
  // deleting proves nothing about who was first; renaming one source under a
  // per-attempt name has exactly one winner on every platform we ship.
  const claimPath = `${path}.spent-${randomBytes(6).toString('hex')}`;
  try {
    await rename(path, claimPath);
  } catch (err) {
    // ENOENT: another redemption claimed it first, or the installer replaced
    // it — this attempt lost the race, an ordinary rejection. Any other errno
    // is an install that cannot spend its own offer, which is the 500.
    return errnoOf(err) === 'ENOENT' ? 'rejected' : 'not-invalidated';
  }
  // Claiming is exclusive, but the read above was not part of it: an installer
  // rerun in that window leaves this attempt holding *its* fresh offer instead.
  // Comparing tokens is how that is told apart from the offer just verified.
  if (!(await claimHolds(claimPath, verifiedToken))) {
    await beforeRelease?.();
    await releaseClaim(claimPath, path);
    return 'rejected';
  }
  // Best-effort: a leftover `.spent-*` file is inert, since it is never at the
  // well-known path the Relay reads. Worth cleaning to keep `run/` tidy, not
  // worth failing an enrollment whose offer is already spent.
  await unlink(claimPath).catch(() => {});
  return 'redeemed';
}

/** Whether the claimed file still holds the offer that was just verified. */
async function claimHolds(claimPath: string, verifiedToken: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(claimPath, 'utf8');
  } catch {
    return false;
  }
  // No warn, unlike the read at the well-known path: an unparseable claim is a
  // half-written installer file, not an install the operator has to repair.
  const claimed = parseEnrollmentOffer(text);
  return claimed !== null && secretEquals(verifiedToken, claimed.token);
}

/** Give back a claim on a file that turned out not to be the verified offer. */
async function releaseClaim(claimPath: string, path: string): Promise<void> {
  // A hard link is an atomic no-clobber publication: it restores this inode
  // only if the well-known path is still absent. `stat` followed by `rename`
  // cannot make that promise on POSIX, where rename would overwrite an offer
  // the installer published between those two calls.
  const restored = await link(claimPath, path).then(
    () => true,
    () => false,
  );
  if (restored) {
    // Both names refer to the same inode; removing the inert claim leaves the
    // restored well-known link and its owner-only permissions intact.
    await unlink(claimPath).catch(() => {});
    return;
  }
  await unlink(claimPath).catch(() => {});
}
