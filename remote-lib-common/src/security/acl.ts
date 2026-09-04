/**
 * The Host ACL: the authorization primitive.
 *
 * Each Host maintains its own local list of approved Clients; it is the
 * authoritative record — the Server cannot add to it. An approved Client is
 * the *pair* of a passkey credential (who) and a per-Host Client static public
 * key (which browser): a connection is authorized only when both appear on the
 * same active record.
 */

import { base64UrlLength, isExactBase64Url } from './bytes.js';
import { NOISE_KEY_LENGTH } from './noise.js';

/** Base64url of a raw 32-byte X25519 public key. */
export const CLIENT_STATIC_PUBLIC_KEY_LENGTH = base64UrlLength(NOISE_KEY_LENGTH);

/** How many bytes a delivery id is: 256 bits, like every other bearer handle. */
export const DELIVERY_ID_BYTE_LENGTH = 32;

/** Base64url of {@link DELIVERY_ID_BYTE_LENGTH} bytes. */
export const DELIVERY_ID_LENGTH = base64UrlLength(DELIVERY_ID_BYTE_LENGTH);

export interface HostAclRecord {
  readonly hostId: string;
  readonly accountId: string;
  readonly passkeyCredentialId: string;
  /** SHA-256 of the passkey's SPKI public key, base64url (see passkey.ts). */
  readonly passkeyPublicKeyHash: string;
  /**
   * Base64url raw 32-byte X25519 public key — the Client's per-Host static, and
   * the browser half of the ACL identity. IK authenticates it during the
   * handshake, so a connection cannot claim one it does not hold the private
   * half of.
   */
  readonly clientStaticPublicKey: string;
  /**
   * The opaque bearer capability this Client registers, queries, and deletes
   * push subscriptions with (`docs/specs/remote-security-model.md` → Push
   * sealing). Minted by the Host at approval, base64url of 32 random bytes, and
   * known only to this record and the Client's own `KnownHostV1`.
   */
  readonly deliveryId: string;
  /** Epoch milliseconds. */
  readonly approvedAt: number;
  /** Who performed the local approval on the Host, e.g. `host-user`. */
  readonly approvedBy: string;
  /** Human-readable client name shown in the Host's UI, e.g. `iPhone Safari`. */
  readonly label: string;
  /** Epoch milliseconds, or null while the record is active. */
  readonly revokedAt: number | null;
}

/**
 * Structural validation of a `HostAclRecord` off disk: hygiene, not
 * authorization, and the exact-length checks on the two E2E fields are the
 * whole of the Host-ACL version (`docs/specs/remote-security-model.md` → Host
 * Authorization).
 */
export function isHostAclRecord(record: unknown): record is HostAclRecord {
  if (!record || typeof record !== 'object') return false;
  const candidate = record as Record<string, unknown>;
  return (
    typeof candidate.hostId === 'string' &&
    typeof candidate.accountId === 'string' &&
    typeof candidate.passkeyCredentialId === 'string' &&
    typeof candidate.passkeyPublicKeyHash === 'string' &&
    isExactBase64Url(candidate.clientStaticPublicKey, CLIENT_STATIC_PUBLIC_KEY_LENGTH) &&
    isExactBase64Url(candidate.deliveryId, DELIVERY_ID_LENGTH) &&
    typeof candidate.approvedAt === 'number' &&
    typeof candidate.approvedBy === 'string' &&
    typeof candidate.label === 'string' &&
    (candidate.revokedAt === null || typeof candidate.revokedAt === 'number')
  );
}

/** Everything the pairing ceremony supplies when approving a Client. */
export interface ApprovedClient {
  readonly accountId: string;
  readonly passkeyCredentialId: string;
  readonly passkeyPublicKeyHash: string;
  readonly clientStaticPublicKey: string;
  readonly deliveryId: string;
  readonly approvedBy: string;
  readonly label: string;
}

export interface HostAclOptions {
  /** Clock returning epoch milliseconds; injectable for tests. */
  readonly now?: () => number;
}

/** Why {@link HostAcl.authorize} found no active record for a (passkey, client) pair. */
export type AclAuthorizationMiss = 'passkey-not-paired' | 'client-not-paired' | 'pairing-mismatch';

/**
 * The result of {@link HostAcl.authorize}: either the single active record that
 * matches both identities, or the reason(s) none does. Because a record is the
 * conjunction of a passkey and a Client static, a miss is explained entirely by
 * which half (if either) is paired — knowledge that belongs here with the record
 * model rather than reconstructed by every caller.
 *
 * **The reasons never leave the Host.** A connection denial carries only
 * `pairing-required` (`docs/specs/remote-security-model.md` → Connection); these
 * are for the owner-local log.
 */
export type AclAuthorization =
  | { readonly record: HostAclRecord }
  | { readonly record: null; readonly reasons: readonly AclAuthorizationMiss[] };

/** A stored record whose `revokedAt` is writable; every other field stays readonly. */
type MutableAclRecord = HostAclRecord & { revokedAt: number | null };

export class HostAcl {
  readonly hostId: string;
  readonly #now: () => number;
  /** Mutable record objects stay private; every public API returns copies. */
  #records: MutableAclRecord[] = [];

  constructor(hostId: string, options: HostAclOptions = {}) {
    this.hostId = hostId;
    this.#now = options.now ?? (() => Date.now());
  }

  /** Restore an ACL from persisted records (the output of {@link records}). */
  static fromRecords(
    hostId: string,
    records: readonly HostAclRecord[],
    options: HostAclOptions = {},
  ): HostAcl {
    const acl = new HostAcl(hostId, options);
    for (const record of records) {
      if (record.hostId !== hostId) {
        throw new Error(`ACL record for host ${record.hostId} cannot be loaded into ${hostId}`);
      }
      acl.#records.push({ ...record });
    }
    return acl;
  }

  /**
   * Add an approved Client. Only the pairing ceremony should call this — it
   * is the step that requires local user approval on the Host. Re-approving
   * an existing (passkey, Client static) pair supersedes the old record.
   */
  approve(client: ApprovedClient): HostAclRecord {
    const now = this.#now();
    const existing = this.#findActive(client.passkeyCredentialId, client.clientStaticPublicKey);
    if (existing) existing.revokedAt = now;
    const record = {
      ...client,
      hostId: this.hostId,
      approvedAt: now,
      revokedAt: null,
    };
    this.#records.push(record);
    return { ...record };
  }

  /** All records, including revoked ones (for persistence and audit UI). */
  records(): HostAclRecord[] {
    return this.#records.map((record) => ({ ...record }));
  }

  activeRecords(): HostAclRecord[] {
    return this.#records
      .filter((record) => record.revokedAt === null)
      .map((record) => ({ ...record }));
  }

  /**
   * The authorization lookup: an active record where BOTH the passkey
   * credential and the Client static match. Matching one but not the other is
   * not authorization.
   */
  findActive(query: {
    readonly passkeyCredentialId: string;
    readonly clientStaticPublicKey: string;
  }): HostAclRecord | undefined {
    const found = this.#findActive(query.passkeyCredentialId, query.clientStaticPublicKey);
    return found ? { ...found } : undefined;
  }

  /**
   * The connection-time authorization lookup: the active record matching BOTH
   * identities, or — when none does — exactly why, derived from whether each
   * identity is independently paired. Keeps the "a record is passkey ∧ Client
   * static" rule next to the record model instead of in the connection layer.
   */
  authorize(query: {
    readonly passkeyCredentialId: string;
    readonly clientStaticPublicKey: string;
  }): AclAuthorization {
    const found = this.#findActive(query.passkeyCredentialId, query.clientStaticPublicKey);
    if (found) return { record: { ...found } };
    const reasons: AclAuthorizationMiss[] = [];
    const passkeyPaired = this.hasActivePasskey(query.passkeyCredentialId);
    const clientPaired = this.hasActiveClient(query.clientStaticPublicKey);
    if (!passkeyPaired) reasons.push('passkey-not-paired');
    if (!clientPaired) reasons.push('client-not-paired');
    if (passkeyPaired && clientPaired) reasons.push('pairing-mismatch');
    return { record: null, reasons };
  }

  hasActivePasskey(passkeyCredentialId: string): boolean {
    return this.#records.some(
      (record) => record.revokedAt === null && record.passkeyCredentialId === passkeyCredentialId,
    );
  }

  hasActiveClient(clientStaticPublicKey: string): boolean {
    return this.#records.some(
      (record) => record.revokedAt === null && record.clientStaticPublicKey === clientStaticPublicKey,
    );
  }

  /** Revoke every active record for a Client static; returns how many were revoked. */
  revokeClient(clientStaticPublicKey: string): number {
    return this.#revokeMatching(
      (record) => record.clientStaticPublicKey === clientStaticPublicKey,
    );
  }

  /** Revoke every active record for a passkey credential; returns how many were revoked. */
  revokePasskey(passkeyCredentialId: string): number {
    return this.#revokeMatching((record) => record.passkeyCredentialId === passkeyCredentialId);
  }

  #findActive(
    passkeyCredentialId: string,
    clientStaticPublicKey: string,
  ): MutableAclRecord | undefined {
    return this.#records.find(
      (record) =>
        record.revokedAt === null &&
        record.passkeyCredentialId === passkeyCredentialId &&
        record.clientStaticPublicKey === clientStaticPublicKey,
    );
  }

  #revokeMatching(matches: (record: HostAclRecord) => boolean): number {
    const now = this.#now();
    let revoked = 0;
    for (const record of this.#records) {
      if (record.revokedAt === null && matches(record)) {
        record.revokedAt = now;
        revoked++;
      }
    }
    return revoked;
  }
}
