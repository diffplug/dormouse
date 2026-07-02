/**
 * The Host ACL: the authorization primitive.
 *
 * Each Host maintains its own local list of approved Clients; it is the
 * authoritative record — the Server cannot add to it. An approved Client is
 * the *pair* of a passkey credential (who) and a device public key (which
 * browser): a connection is authorized only when both appear on the same
 * active record.
 */

export interface HostAclRecord {
  readonly hostId: string;
  readonly accountId: string;
  readonly passkeyCredentialId: string;
  /** SHA-256 of the passkey's SPKI public key, base64url (see passkey.ts). */
  readonly passkeyPublicKeyHash: string;
  /** Base64url raw P-256 point — the Client's identity (see deviceKey.ts). */
  readonly devicePublicKey: string;
  /** Epoch milliseconds. */
  readonly approvedAt: number;
  /** Who performed the local approval on the Host, e.g. `host-user`. */
  readonly approvedBy: string;
  /** Human-readable client name shown in the Host's UI, e.g. `iPhone Safari`. */
  readonly label: string;
  /** Epoch milliseconds, or null while the record is active. */
  readonly revokedAt: number | null;
}

/** Everything the pairing ceremony supplies when approving a Client. */
export interface ApprovedClient {
  readonly accountId: string;
  readonly passkeyCredentialId: string;
  readonly passkeyPublicKeyHash: string;
  readonly devicePublicKey: string;
  readonly approvedBy: string;
  readonly label: string;
}

export interface HostAclOptions {
  /** Clock returning epoch milliseconds; injectable for tests. */
  readonly now?: () => number;
}

/** Why {@link HostAcl.authorize} found no active record for a (passkey, device) pair. */
export type AclAuthorizationMiss = 'passkey-not-paired' | 'device-not-paired' | 'pairing-mismatch';

/**
 * The result of {@link HostAcl.authorize}: either the single active record that
 * matches both identities, or the reason(s) none does. Because a record is the
 * conjunction of a passkey and a device, a miss is explained entirely by which
 * half (if either) is paired — knowledge that belongs here with the record
 * model rather than reconstructed by every caller.
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
   * an existing (passkey, device key) pair supersedes the old record.
   */
  approve(client: ApprovedClient): HostAclRecord {
    const now = this.#now();
    const existing = this.#findActive(client.passkeyCredentialId, client.devicePublicKey);
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
   * credential and the device key match. Matching one but not the other is
   * not authorization.
   */
  findActive(query: {
    readonly passkeyCredentialId: string;
    readonly devicePublicKey: string;
  }): HostAclRecord | undefined {
    const found = this.#findActive(query.passkeyCredentialId, query.devicePublicKey);
    return found ? { ...found } : undefined;
  }

  /**
   * The connection-time authorization lookup: the active record matching BOTH
   * identities, or — when none does — exactly why, derived from whether each
   * identity is independently paired. Keeps the "a record is passkey ∧ device"
   * rule next to the record model instead of in the connection layer.
   */
  authorize(query: {
    readonly passkeyCredentialId: string;
    readonly devicePublicKey: string;
  }): AclAuthorization {
    const found = this.#findActive(query.passkeyCredentialId, query.devicePublicKey);
    if (found) return { record: { ...found } };
    const reasons: AclAuthorizationMiss[] = [];
    const passkeyPaired = this.hasActivePasskey(query.passkeyCredentialId);
    const devicePaired = this.hasActiveDevice(query.devicePublicKey);
    if (!passkeyPaired) reasons.push('passkey-not-paired');
    if (!devicePaired) reasons.push('device-not-paired');
    if (passkeyPaired && devicePaired) reasons.push('pairing-mismatch');
    return { record: null, reasons };
  }

  hasActivePasskey(passkeyCredentialId: string): boolean {
    return this.#records.some(
      (record) => record.revokedAt === null && record.passkeyCredentialId === passkeyCredentialId,
    );
  }

  hasActiveDevice(devicePublicKey: string): boolean {
    return this.#records.some(
      (record) => record.revokedAt === null && record.devicePublicKey === devicePublicKey,
    );
  }

  /** Revoke every active record for a device key; returns how many were revoked. */
  revokeDevice(devicePublicKey: string): number {
    return this.#revokeMatching((record) => record.devicePublicKey === devicePublicKey);
  }

  /** Revoke every active record for a passkey credential; returns how many were revoked. */
  revokePasskey(passkeyCredentialId: string): number {
    return this.#revokeMatching((record) => record.passkeyCredentialId === passkeyCredentialId);
  }

  #findActive(
    passkeyCredentialId: string,
    devicePublicKey: string,
  ): MutableAclRecord | undefined {
    return this.#records.find(
      (record) =>
        record.revokedAt === null &&
        record.passkeyCredentialId === passkeyCredentialId &&
        record.devicePublicKey === devicePublicKey,
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
