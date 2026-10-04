/**
 * An account's enrolled Burrows as a person sees them: how many it may hold,
 * and the name the account page lists each under and the desktop shows for
 * itself, so the two can be matched (`docs/specs/hosted.md` -> "Burrow
 * enrollment").
 *
 * Imports nothing, so the account frontend takes it without the rest of this
 * package.
 */

/**
 * How many Burrows one account may have enrolled, on either Relay.
 *
 * Enrollment is credential-gated, so this is not a flood defense. On the
 * self-host Relay it bounds a file that is otherwise append-only and is
 * re-read, re-parsed and compared row by row on every burrow-gated request and
 * every `/ws/burrow` upgrade; on Hosted it bounds what one account's approvals
 * can grow. Far above the machines a person owns; revocation (self-host) or
 * removal (Hosted) is what makes room.
 */
export const MAX_ENROLLED_BURROWS = 32;

/**
 * What a Burrow is called to a person: the account page lists it so, and the
 * desktop names itself so. A Burrow's label never leaves the machine, so the
 * id is the one name both ends have.
 */
export function computerName(burrowId: string): string {
  return `Computer ${burrowId.slice(0, 8)}`;
}
