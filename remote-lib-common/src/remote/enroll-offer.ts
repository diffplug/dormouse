/**
 * The enrollment offer an installer leaves on disk: the origin its Relay
 * answers on, plus a one-time token that redeems for a Host enrollment in
 * place of the setup password (docs/specs/relay.md, "Configuration" ->
 * `DORMOUSE_ENROLL_TOKEN_FILE`).
 *
 * The shape lives here because two processes read the same file: a Host on
 * that machine, which offers one-click enrollment from it, and the Relay,
 * which redeems the token against its own copy.
 */

import { isOrigin } from './origin.js';

export interface EnrollmentOffer {
  /** Where the Relay answers, e.g. `https://dormouse.tailnet.ts.net`. */
  readonly origin: string;
  /** 64 lowercase hex characters — 32 bytes from the installer's CSPRNG. */
  readonly token: string;
  /**
   * ISO-8601 stamp of the mint. Load-bearing, not informational: the Relay
   * refuses an offer whose stamp will not `Date.parse` or is more than 24 hours
   * old, so a writer that stamps this in a
   * non-invariant format mints a token nothing can redeem.
   */
  readonly mintedAt: string;
}

/** The canonical encoding of a 32-byte value shared across remote credentials. */
export const HEX_ENCODED_32_BYTES_PATTERN = /^[0-9a-f]{64}$/;

/** The token's public format, so a redeemer can refuse junk before reading disk. */
export const ENROLL_TOKEN_PATTERN = HEX_ENCODED_32_BYTES_PATTERN;

/** How long a bootstrap offer stays redeemable before the first Host enrolls. */
export const ENROLL_OFFER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Bound on the displayed `mintedAt`; an ISO-8601 stamp needs about 30. */
const MINTED_AT_MAX_LENGTH = 64;

/**
 * Structural validation of an offer read back off disk. Whoever can write the
 * file chooses every field, so this authorizes nothing — it only ensures the
 * token reaching a constant-time compare and the origin reaching a `URL` are
 * the shapes those uses assume.
 */
export function isEnrollmentOffer(value: unknown): value is EnrollmentOffer {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.origin === 'string' &&
    isOrigin(candidate.origin) &&
    typeof candidate.token === 'string' &&
    ENROLL_TOKEN_PATTERN.test(candidate.token) &&
    typeof candidate.mintedAt === 'string' &&
    candidate.mintedAt.length > 0 &&
    candidate.mintedAt.length <= MINTED_AT_MAX_LENGTH
  );
}

/**
 * One offer file's text as an offer, or `null` for every way it can fail to be
 * one — not JSON, wrong shape. Never throws.
 *
 * Here rather than in either reader because both of them parse the same file:
 * the Relay redeeming the token (`relay/src/enroll-token.ts`) and the Host
 * offering one-click enrollment from it (`lib/src/host/remote/enroll-offer.ts`).
 * Each keeps its own `fs` handling — and the Relay its warn-on-unusable — but
 * one format has one parser.
 */
export function parseEnrollmentOffer(text: string): EnrollmentOffer | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isEnrollmentOffer(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Whether an offer is still inside the shared Relay/Host display window.
 * A future stamp passes: one machine writes and reads the file, so clock skew
 * is not evidence of anything and must not brick the one-click path.
 */
export function isEnrollmentOfferFresh(offer: EnrollmentOffer, now: number = Date.now()): boolean {
  const minted = Date.parse(offer.mintedAt);
  return !Number.isNaN(minted) && now - minted <= ENROLL_OFFER_MAX_AGE_MS;
}
