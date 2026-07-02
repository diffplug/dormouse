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

export class HostAcl {
  readonly hostId: string;
  readonly #now: () => number;
  /** Mutable record objects stay private; every public API returns copies. */
  #records: Array<HostAclRecord & { revokedAt: number | null }> = [];

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
  ): (HostAclRecord & { revokedAt: number | null }) | undefined {
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
