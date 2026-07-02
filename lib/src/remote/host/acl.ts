/**
 * Host ACL persistence. The ACL is the authorization primitive (see
 * `server-lib-common/security/acl.ts`) and — per the security model — it lives
 * on the Host, never the Server. Here it is persisted to `localStorage` as the
 * record array `HostAcl.records()` produces, restored via `HostAcl.fromRecords`.
 *
 * Keyed per host so a browser profile that re-enrolls under a new hostId does
 * not inherit a stale ACL.
 */

import { HostAcl, type HostAclRecord } from 'server-lib-common';

export const ACL_KEY_PREFIX = 'dormouse.remote-host.acl.';

function aclKey(hostId: string): string {
  return `${ACL_KEY_PREFIX}${hostId}`;
}

/** Load the persisted records for a host, dropping anything malformed. */
export function loadAclRecords(hostId: string): HostAclRecord[] {
  try {
    const raw = globalThis.localStorage?.getItem(aclKey(hostId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Only keep records for this host; fromRecords rejects a mismatched hostId.
    return parsed.filter(
      (record): record is HostAclRecord =>
        !!record && typeof record === 'object' && (record as HostAclRecord).hostId === hostId,
    );
  } catch {
    return [];
  }
}

export function saveAclRecords(hostId: string, records: readonly HostAclRecord[]): void {
  try {
    globalThis.localStorage?.setItem(aclKey(hostId), JSON.stringify(records));
  } catch {
    // No localStorage: the in-memory ACL still works for this session.
  }
}

/** Rehydrate a live `HostAcl` from persisted records. */
export function loadHostAcl(hostId: string): HostAcl {
  try {
    return HostAcl.fromRecords(hostId, loadAclRecords(hostId));
  } catch {
    return new HostAcl(hostId);
  }
}
