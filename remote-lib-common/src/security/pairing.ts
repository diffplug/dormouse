/**
 * Pairing constants and the label reducer both ceremonies share.
 *
 * The ceremony itself is `e2e-ceremony.ts` — `PairingRequestV1`,
 * `PairingOutcomeV1`, and the presence proof — over the invitation grammar in
 * `pairing-invitation.ts`. What lives here is the vocabulary neither of those
 * owns: the TTL, the pending-request cap, and the bound on an attacker-chosen
 * device label.
 */
import { boundedPushText } from './push.js';

export const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;

/**
 * How many pairing requests may await local approval at once, across the
 * Host's own client map and the service's mirrored queue.
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
 * The longest label the approval modal will render, in code points. Generous
 * for a device name and far short of anything that can push the Approve/Deny
 * buttons off a laptop screen.
 */
const PAIRING_LABEL_LIMIT = 64;

/**
 * A device label reduced to something safe to render in the approval
 * modal. Same rule as `boundedPushText`, and for a stronger reason: the label
 * is attacker-chosen free text, and this is the one dialog the entire ACL
 * rests on. An unbounded label can push the buttons out of view, and a bidi
 * override can make the displayed text read as something other than what it
 * is.
 */
export function boundedPairingLabel(value: unknown): string {
  return boundedPushText(value, { limit: PAIRING_LABEL_LIMIT, fallback: '(unnamed)' });
}

/**
 * The Host's *own* label, reduced before it goes on the wire.
 *
 * Not attacker-chosen — it is the machine's name — but the Client's outcome
 * guards refuse any field over `CEREMONY_FIELD_LIMIT`, so an unbounded one
 * would pair on the laptop and be discarded by the phone, leaving the two
 * permanently disagreeing about whether they are paired. Empty is a legal
 * answer, unlike a device label nobody would recognize unnamed.
 */
export function boundedHostLabel(value: unknown): string {
  return boundedPushText(value, { limit: PAIRING_LABEL_LIMIT, fallback: '' });
}
