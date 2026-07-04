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
import { loadJson, saveJson } from '../../lib/local-json-store';

export const ACL_KEY_PREFIX = 'dormouse.remote-host.acl.';

function aclKey(hostId: string): string {
  return `${ACL_KEY_PREFIX}${hostId}`;
}

/** Load the persisted records for a host, dropping anything malformed. */
export function loadAclRecords(hostId: string): HostAclRecord[] {
  // Missing key / malformed JSON / non-array all collapse to `[]`.
  const parsed = loadJson<unknown[]>(aclKey(hostId), [], Array.isArray);
  // Only keep records for this host; fromRecords rejects a mismatched hostId.
  return parsed.filter(
    (record): record is HostAclRecord =>
      !!record && typeof record === 'object' && (record as HostAclRecord).hostId === hostId,
  );
}

export function saveAclRecords(hostId: string, records: readonly HostAclRecord[]): void {
  saveJson(aclKey(hostId), records);
}

/**
 * Rehydrate a live `HostAcl` from persisted records, falling back to an empty
 * ACL if the stored records cannot be reconciled with `hostId`. `loadRecords`
 * is injectable so callers (and tests) can supply their own source.
 */
export function loadHostAcl(
  hostId: string,
  loadRecords: (hostId: string) => HostAclRecord[] = loadAclRecords,
): HostAcl {
  try {
    return HostAcl.fromRecords(hostId, loadRecords(hostId));
  } catch (error) {
    // Fail closed but loudly: an empty ACL silently de-pairs every client, so
    // "all my devices vanished" must at least be explicable from the console.
    console.warn(`remote-host: could not load ACL for ${hostId}; starting empty`, error);
    return new HostAcl(hostId);
  }
}
