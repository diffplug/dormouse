/**
 * An account's enrolled Burrows as a person sees them: how many it may hold,
 * the name the account page lists each under and the desktop shows for
 * itself, so the two can be matched, and the desktop button that adds one (`docs/specs/hosted.md` -> "Burrow
 * enrollment").
 *
 * Imports nothing, so the account frontend takes it without the rest of this
 * package.
 */

/**
 * How many Burrows the self-host Relay may have enrolled.
 *
 * Enrollment is credential-gated, so this is not a flood defense: it bounds a
 * file that is otherwise append-only and is re-read, re-parsed and compared
 * row by row on every burrow-gated request and every `/ws/burrow` upgrade. Far
 * above the machines a person owns; revocation is what makes room.
 */
export const MAX_ENROLLED_BURROWS = 32;

/**
 * Computers one Hosted account may enroll: an abuse ceiling, not a plan limit
 * — a member has no device limit (`docs/specs/pricing.md` -> "Checkout and
 * entitlement"). Removal is what makes room.
 */
export const MAX_BURROWS_PER_ACCOUNT = 1000;

/**
 * What a Burrow is called to a person: the account page lists it so, and the
 * desktop names itself so. A Burrow's label never leaves the machine, so the
 * id is the one name both ends have.
 */
export function computerName(burrowId: string): string {
  return `Computer ${burrowId.slice(0, 8)}`;
}

/** The desktop button that signs a computer in, which the account page tells a person to press. */
export const HOSTED_SIGN_IN_LABEL = 'Sign in to Dormouse Hosted';
