/**
 * The enrollment offer a Dormouse Server installer left on *this* machine, read
 * from the Node side of a Host so the Settings dialog can offer one-click
 * enrollment (`docs/specs/server.md` → "Remote control, in the Settings
 * dialog").
 *
 * The file is the installer's `run/enroll-offer.json` — the same one the Server
 * redeems through `DORMOUSE_ENROLL_TOKEN_FILE`, shape and guard shared in
 * `server-lib-common/src/remote/enroll-offer.ts`. There is no handshake between
 * the two processes: both simply know where the installer puts it.
 *
 * Freshness is shared with the Server. This process reads the file from the
 * same machine that stamped it, so an expired offer disappears from Settings
 * instead of leading with a button the Server can only reject.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  isEnrollmentOfferFresh,
  parseEnrollmentOffer,
  type EnrollmentOffer,
} from 'server-lib-common';

export type { EnrollmentOffer };

const OFFER_FILE = join('run', 'enroll-offer.json');

/**
 * Where each installer's offer lands, mirroring the install root that installer
 * picks (`deploy/local/install-{macos,windows,linux}`) — pinned against those
 * three scripts by `lib/src/lib/mirrored-constants.test.ts`, since nothing links
 * the two sides at build time and a drift is a one-click enrollment that
 * silently never appears. `null` means "there is no path to look at", which
 * reads the same as no offer.
 *
 * Exported for its tests; callers want {@link readEnrollmentOffer}. The
 * parameters exist so those can cover all three platforms from one, and are
 * defaulted rather than injected everywhere else.
 */
export function enrollmentOfferPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string | null {
  switch (platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Dormouse Server', OFFER_FILE);
    case 'win32':
      // No `%LOCALAPPDATA%` is not a path to guess at: the installer joins onto
      // that variable, so without it this machine's install root is unknown.
      return env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Dormouse Server', OFFER_FILE) : null;
    default:
      // `||` and not `??`, matching the installers' `${XDG_DATA_HOME:-…}`: an
      // empty value is unset, not a root at the filesystem's top.
      return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'dormouse-server', OFFER_FILE);
  }
}

/**
 * The offer on this machine, or `null` — silently, for every failure including
 * the ENOENT that is the *normal* answer: most machines run no server, and a
 * Host that logged about a missing file would log it on every status read.
 *
 * **Never rejects.** Both call sites are status paths that have no better
 * answer than "no offer" for a failed read, so callers may await it bare rather
 * than each guarding a rejection that cannot arrive — pinned by "is silently
 * null for every failure" in `enroll-offer.test.ts`.
 *
 * Resolves the path per call rather than caching it, because the answer changes
 * under a running Host: the installer mints an offer, and redeeming one unlinks
 * the file.
 */
export async function readEnrollmentOffer(
  path: string | null = enrollmentOfferPath(),
  now: number = Date.now(),
): Promise<EnrollmentOffer | null> {
  if (!path) return null;
  try {
    // Whoever can write the file chooses every field, so the shared parse
    // authorizes nothing — it only keeps a malformed origin or token from
    // reaching the enrollment exchange as though it were one.
    const offer = parseEnrollmentOffer(await readFile(path, 'utf8'));
    return offer !== null && isEnrollmentOfferFresh(offer, now) ? offer : null;
  } catch {
    return null;
  }
}
