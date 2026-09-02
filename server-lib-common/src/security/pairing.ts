/**
 * The pairing ceremony: how a Client earns a Host ACL record.
 *
 * Pairing is the only path into the ACL, and its critical step — `approve` —
 * models the local approval UI on the Host. The Server can relay a pairing
 * *request*, but only someone at the Host can turn it into authorization.
 *
 * Integration contract: presence for pairing is server-attested plus
 * Host-approved. The Server relays a pairing request only while the session's
 * last server-verified passkey assertion is within
 * {@link PAIRING_PRESENCE_WINDOW_MS} (sign-in, re-auth, and the connect2
 * handshake all refresh the stamp); a stale session is answered with
 * {@link PAIRING_STALE_PRESENCE_ERROR} and the Client re-asserts with one
 * WebAuthn prompt, then retries. The Host does not re-verify an assertion at
 * pairing time — its stronger control is the mandatory local approval below,
 * unlike connect, where `authorizeConnection` verifies presence itself
 * (docs/specs/remote-security-model.md, Pairing Ceremony).
 */

import { isBoundedString, toBase64Url } from './bytes.js';
import { getWebCrypto, type WebCryptoLike } from './webcrypto.js';
import { HostAcl, type HostAclRecord } from './acl.js';
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
const PAIRING_ID_BYTE_LENGTH = 16;

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
 * than both, and `authorizeConnection` neither reads it nor is bound by it. A
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
 * (`authorizeConnection` contains a malformed request as a denial); this is
 * the same rule for `pair`.
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

export type PairingState = 'pending' | 'approved' | 'denied' | 'expired';

/** A snapshot of one pairing attempt, e.g. for the Host's approval UI. */
export interface PairingTicket {
  readonly pairingId: string;
  readonly state: PairingState;
  readonly request: PairingRequest;
  readonly requestedAt: number;
  readonly expiresAt: number;
}

export type PairingErrorCode = 'unknown-pairing' | 'not-pending' | 'expired';

export class PairingError extends Error {
  readonly code: PairingErrorCode;

  constructor(code: PairingErrorCode, message: string) {
    super(message);
    this.name = 'PairingError';
    this.code = code;
  }
}

export interface PairingCeremonyOptions {
  readonly ttlMs?: number;
  /** Clock returning epoch milliseconds; injectable for tests. */
  readonly now?: () => number;
  readonly crypto?: WebCryptoLike;
}

export class PairingCeremony {
  readonly #acl: HostAcl;
  readonly #tickets = new Map<string, Ticket>();
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #crypto: WebCryptoLike;

  constructor(acl: HostAcl, options: PairingCeremonyOptions = {}) {
    this.#acl = acl;
    this.#ttlMs = options.ttlMs ?? DEFAULT_PAIRING_TTL_MS;
    this.#now = options.now ?? (() => Date.now());
    this.#crypto = options.crypto ?? getWebCrypto();
  }

  /** Register a pairing request and hand back the ticket to show for approval. */
  begin(request: PairingRequest): PairingTicket {
    const pairingId = toBase64Url(
      this.#crypto.getRandomValues(new Uint8Array(PAIRING_ID_BYTE_LENGTH)),
    );
    const requestedAt = this.#now();
    const ticket: Ticket = {
      pairingId,
      state: 'pending',
      request: { ...request },
      requestedAt,
      expiresAt: requestedAt + this.#ttlMs,
    };
    this.#pruneTickets();
    this.#tickets.set(pairingId, ticket);
    return this.#snapshot(ticket);
  }

  get(pairingId: string): PairingTicket | undefined {
    const ticket = this.#tickets.get(pairingId);
    return ticket ? this.#snapshot(ticket) : undefined;
  }

  /**
   * The local user approval on the Host. This is the ONLY call that writes to
   * the ACL. Throws {@link PairingError} unless the ticket is pending and
   * unexpired.
   */
  approve(pairingId: string, approval: { approvedBy: string; label?: string }): HostAclRecord {
    const ticket = this.#requirePending(pairingId);
    ticket.state = 'approved';
    return this.#acl.approve({
      accountId: ticket.request.accountId,
      passkeyCredentialId: ticket.request.passkeyCredentialId,
      passkeyPublicKeyHash: ticket.request.passkeyPublicKeyHash,
      devicePublicKey: ticket.request.devicePublicKey,
      approvedBy: approval.approvedBy,
      label: approval.label ?? ticket.request.requestedLabel,
    });
  }

  /** Reject a pending pairing request; the ACL is untouched. */
  deny(pairingId: string): void {
    const ticket = this.#requirePending(pairingId);
    ticket.state = 'denied';
  }

  #requirePending(pairingId: string): Ticket {
    const ticket = this.#tickets.get(pairingId);
    if (!ticket) throw new PairingError('unknown-pairing', `unknown pairing ${pairingId}`);
    this.#reapExpiry(ticket);
    if (ticket.state === 'expired') {
      throw new PairingError('expired', `pairing ${pairingId} expired`);
    }
    if (ticket.state !== 'pending') {
      throw new PairingError('not-pending', `pairing ${pairingId} is already ${ticket.state}`);
    }
    return ticket;
  }

  /**
   * Bound the ticket map. Every `pair` frame the relay forwards mints a
   * ticket, and nothing else ever removed one — a signed-in account can send
   * them faster than the 30-second presence window closes, and they accumulate
   * in the Host process on the user's laptop.
   *
   * Resolved and expired tickets are kept for one extra TTL rather than
   * dropped on resolution, so a second approve on a ticket the user just acted
   * on still fails as `not-pending` / `expired` — the error the UI and the
   * spec describe — instead of degrading to `unknown-pairing`.
   */
  #pruneTickets(): void {
    const cutoff = this.#now() - this.#ttlMs;
    for (const [pairingId, ticket] of this.#tickets) {
      if (ticket.expiresAt <= cutoff) this.#tickets.delete(pairingId);
    }
    // Age alone is rate-bounded, not bounded: a relay that sends pair frames
    // faster than they expire still grows this map for one whole grace window.
    // A count cap is the actual bound. Oldest first — `Map` iterates in
    // insertion order, and the oldest pending request is the one whose human
    // is least likely to still be looking at the modal.
    while (this.#tickets.size >= MAX_PENDING_TICKETS) {
      const oldest = this.#tickets.keys().next();
      if (oldest.done) break;
      this.#tickets.delete(oldest.value);
    }
  }

  #reapExpiry(ticket: Ticket): void {
    if (ticket.state === 'pending' && this.#now() >= ticket.expiresAt) {
      ticket.state = 'expired';
    }
  }

  #snapshot(ticket: Ticket): PairingTicket {
    this.#reapExpiry(ticket);
    return { ...ticket, request: { ...ticket.request } };
  }
}

interface Ticket {
  readonly pairingId: string;
  state: PairingState;
  readonly request: PairingRequest;
  readonly requestedAt: number;
  readonly expiresAt: number;
}
