/**
 * Pairing constants and the Burrow's own label bound.
 *
 * The ceremony itself is `e2e-ceremony.ts` — `PairingRequestV1`,
 * `PairingOutcomeV1`, the presence proof, and the closed set a Client's device
 * label must come from — over the invitation grammar in
 * `pairing-invitation.ts`. What lives here is the vocabulary neither of those
 * owns: the TTL, the pending-request cap, and the bound on the Burrow's label.
 */
import { boundedPushText } from './push.js';

export const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;

/**
 * How many pairing requests may await local approval at once, across the
 * Burrow's own client map and the service's mirrored queue.
 *
 * Small, because this is the number a *human* is being asked to look at: past a
 * handful the modal is not a decision any more. Oldest is evicted first — the
 * person who initiated the oldest request is the least likely to still be
 * watching for it.
 *
 * Every pairing `init` allocates in both structures keyed by a `clientId` the
 * relay chooses, and the service re-serializes its whole queue to the webview
 * on each change, so the cost of leaving them unbounded is quadratic rather
 * than linear.
 */
export const MAX_PENDING_PAIRINGS = 8;

/**
 * The longest Burrow label sent to a Client, in code points: generous for a
 * machine name.
 */
const BURROW_LABEL_LIMIT = 64;

/**
 * The Burrow's *own* label, reduced before it goes on the wire.
 *
 * Not attacker-chosen — it is the machine's name — but the Client's outcome
 * guards refuse any field over `CEREMONY_FIELD_LIMIT`, so an unbounded one
 * would pair on the laptop and be discarded by the phone, leaving the two
 * permanently disagreeing about whether they are paired. Empty is a legal
 * answer.
 */
export function boundedBurrowLabel(value: unknown): string {
  return boundedPushText(value, { limit: BURROW_LABEL_LIMIT, fallback: '' });
}
