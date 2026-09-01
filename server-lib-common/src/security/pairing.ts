/**
 * Pairing constants and the shape guards the legacy relay frames still run.
 *
 * The Host's ceremony itself is `e2e-ceremony.ts` — `PairingRequestV1`,
 * `PairingOutcomeV1`, and the presence proof — over the invitation grammar in
 * `pairing-invitation.ts`. What remains here is the vocabulary the *Server*
 * still speaks on the legacy `pair` path plus the bounds and labels both
 * ceremonies share.
 *
 * STAGE-4 TRANSITIONAL: `PairingRequest`, `isPairingRequest`, `PairStatusQuery`,
 * `isPairStatusQuery`, `pairingFingerprint`, `PAIRING_PRESENCE_WINDOW_MS`, and
 * `PAIRING_STALE_PRESENCE_ERROR` exist only for the legacy relay path and the
 * Pocket client that has not switched yet; they are deleted in 4c.
 */

import { isBoundedString } from './bytes.js';
import { boundedPushText } from './push.js';

export const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;

/**
 * How many tickets one ceremony will hold. Far above any real use — a human
 * approves one at a time — and low enough that a hostile relay cannot turn
 * `pair` frames into unbounded memory here.
 *
 * This bounds the ceremony's own map and nothing else. The Host keeps its own
 * per-`clientId` records of a pending pairing, and the service mirrors a queue
 * of them to the webview; both are bounded separately by
 * {@link MAX_PENDING_PAIRINGS}. Capping only this map is what let 5000 `pair`
 * frames retain ~16 MB of relay-chosen strings while `#tickets` sat happily at
 * 64.
 */
const MAX_PENDING_TICKETS = 64;

/**
 * How many pairing requests may await local approval at once, across the
 * Host's own client map and the service's mirrored queue.
 *
 * Much smaller than {@link MAX_PENDING_TICKETS}, because this is the number a
 * *human* is being asked to look at: past a handful the modal is not a
 * decision any more. Oldest is evicted first — the person who initiated the
 * oldest request is the least likely to still be watching for it.
 *
 * Every `pair` frame allocates in both structures keyed by a `clientId` the
 * relay chooses, and the service re-serializes its whole queue to the webview
 * on each change, so the cost of leaving them unbounded is quadratic rather
 * than linear.
 */
export const MAX_PENDING_PAIRINGS = 8;

/**
 * How recent the session's last server-verified passkey assertion must be for
 * the Server to relay a pairing request. Tight on purpose: it covers
 * "sign in, then tap Pair", and anything slower costs exactly one extra
 * biometric prompt via re-auth.
 */
export const PAIRING_PRESENCE_WINDOW_MS = 30_000;

/** `pair-result.error` code telling the Client to re-assert presence and retry. */
export const PAIRING_STALE_PRESENCE_ERROR = 'stale-presence';

/** What a Client submits to request pairing (after passkey authentication). */
export interface PairingRequest {
  readonly accountId: string;
  readonly passkeyCredentialId: string;
  /** See passkey.ts `hashPasskeyPublicKey`. */
  readonly passkeyPublicKeyHash: string;
  /** The Client identity being authorized (see deviceKey.ts). */
  readonly devicePublicKey: string;
  /** Client-suggested label; the approver may override it. */
  readonly requestedLabel: string;
  /**
   * `computeSetupProof` under the setup nonce this Client scanned off a Host's
   * QR, when it was set up that way (`setup-proof.ts`). Absent on the QR-less
   * path, so every consumer must treat it as optional.
   *
   * The Server checks only that it is a bounded string, and cannot do more: the
   * nonce behind it never travels through the Server, so this is a MAC the
   * Server can neither verify nor produce — which is what stops it from moving
   * `verified` onto a device key of its own choosing.
   */
  readonly setupProof?: string;
}

/**
 * What a Client asks a Host about itself: is this (passkey credential, device
 * key) pair on your ACL?
 *
 * The two fields are exactly the ACL's lookup key, so the Host answers with a
 * plain `HostAcl.findActive` — no ceremony, no challenge, no signature. It is
 * **advisory display truth only**: it lets Pocket offer Pair or Connect rather
 * than both, and the connection ceremony neither reads it nor is bound by it. A
 * wrong answer — a compromised relay, a Host whose ACL changed mid-query —
 * therefore costs at most a button the user has to tap twice.
 *
 * It carries no proof of ownership, and an authenticated session can assemble
 * askable pairs beyond its own — the account's device keys are visible to any
 * signed-in session via `GET /api/push/subscriptions` — so a stolen synced
 * passkey does allow silently mapping which browsers are paired where. That
 * yields reconnaissance only: every pair it can learn about was authorized by
 * a person at the Host, and the answer still grants nothing.
 */
export interface PairStatusQuery {
  readonly passkeyCredentialId: string;
  readonly devicePublicKey: string;
}

/**
 * Structural validation of a {@link PairStatusQuery} off the wire, run on both
 * sides for the same reason {@link isPairingRequest} is: the Host does not
 * trust the relay that hands it one.
 */
export function isPairStatusQuery(query: unknown): query is PairStatusQuery {
  if (!query || typeof query !== 'object') return false;
  const candidate = query as Record<string, unknown>;
  return bounded(candidate.passkeyCredentialId) && bounded(candidate.devicePublicKey);
}

/**
 * The longest `requestedLabel` the approval modal will render, in code points.
 * Generous for a device name and far short of anything that can push the
 * Approve/Deny buttons off a laptop screen.
 */
export const PAIRING_LABEL_LIMIT = 64;

/**
 * The device-key fingerprint shown to a human during pairing: the leading
 * characters of the base64url device public key.
 *
 * Shared, because it is only useful if **both** ends render the same thing.
 * The Host's approval modal shows the fingerprint of the key that is asking;
 * Pocket shows the fingerprint of its own key. Comparing them is what turns
 * the modal from a prompt the user can only accept on faith into one they can
 * actually check — the pairing ceremony verifies no assertion, so the human is
 * the control (`docs/specs/remote-security-model.md`, Pairing Ceremony).
 */
export const PAIRING_FINGERPRINT_LENGTH = 8;

/**
 * Where the fingerprint starts, and why it is not zero.
 *
 * A device public key is a *raw* P-256 point: the uncompressed-form tag `0x04`
 * followed by X and Y. Base64url of that always begins `B`, and its second
 * character only ever takes 16 values (two fixed bits from the tag plus four
 * from X) — verified empirically over generated keys. Slicing from zero would
 * therefore spend two of eight displayed characters on ~4 bits, leaving ~40
 * where the length implies ~48. Since the whole point of the fingerprint is
 * that a human compares it against another one, every displayed character has
 * to be doing work.
 */
const FINGERPRINT_OFFSET = 2;

/** The fingerprint of a device public key, for display to a human. */
export function pairingFingerprint(devicePublicKey: string): string {
  return devicePublicKey.slice(FINGERPRINT_OFFSET, FINGERPRINT_OFFSET + PAIRING_FINGERPRINT_LENGTH);
}

/**
 * Structural validation of a `PairingRequest` off the wire.
 *
 * Shared, and used on **both** sides, for the reason the whole security model
 * exists: the Server relays this frame, and the Host does not trust the
 * Server. A guard that ran only on the Server would leave the Host — the party
 * that actually writes the ACL and renders the approval UI — taking a
 * relay-supplied object on faith. `connect2` has always been defended this way
 * (a malformed connection request is contained as a denial); this is the same
 * rule for `pair`.
 */
export function isPairingRequest(request: unknown): request is PairingRequest {
  if (!request || typeof request !== 'object') return false;
  const candidate = request as Record<string, unknown>;
  return (
    bounded(candidate.accountId) &&
    bounded(candidate.passkeyCredentialId) &&
    bounded(candidate.passkeyPublicKeyHash) &&
    bounded(candidate.devicePublicKey) &&
    bounded(candidate.requestedLabel) &&
    // Optional, so absent passes — but a present one is bounded like every
    // other field, since it is relay-supplied text either way.
    (candidate.setupProof === undefined || bounded(candidate.setupProof))
  );
}

/**
 * The longest any single `PairingRequest` field may be.
 *
 * Type checks alone bound nothing: a megabyte string is a `string`. Every real
 * field here is a base64url key, a hash, a credential id, or a device name —
 * all comfortably under this. The frame itself is not otherwise capped
 * (`@hono/node-ws` constructs its `WebSocketServer` with `ws`'s 100 MiB
 * default), so this is where a pairing frame stops being able to cost the Host
 * process memory proportional to what the relay chose to send.
 */
const PAIRING_FIELD_LIMIT = 1024;

function bounded(value: unknown): value is string {
  return isBoundedString(value, PAIRING_FIELD_LIMIT);
}

/**
 * A `requestedLabel` reduced to something safe to render in the approval
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
 * The other field the approval modal renders, reduced by the same rule.
 *
 * `accountId` is as attacker-chosen as the label is when the relay is hostile,
 * and bounding one without the other just moves the overflow. The modal has no
 * max-height, so an unbounded value here pushes Approve and Deny off the
 * screen — a denial-of-service on the one dialog that must stay usable.
 */
export function boundedPairingAccount(value: unknown): string {
  return boundedPushText(value, { limit: PAIRING_LABEL_LIMIT, fallback: '(unknown)' });
}
