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

import { toBase64Url } from './bytes.js';
import { getWebCrypto, type WebCryptoLike } from './webcrypto.js';
import { HostAcl, type HostAclRecord } from './acl.js';

export const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;

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
