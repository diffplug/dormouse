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
import { loadJson, removeJson, saveJson } from '../../lib/local-json-store';

export const ACL_KEY_PREFIX = 'dormouse.remote-host.acl.';

function aclKey(hostId: string): string {
  return `${ACL_KEY_PREFIX}${hostId}`;
}

/**
 * Keep only the records that belong to `hostId`, dropping anything that is not
 * a record at all.
 *
 * Exported because every store that reads an ACL back — this one, the sidecar's
 * file, VS Code's `globalState`, an `adopt` a webview sent — reads it as
 * `unknown[]`, and `HostAcl.fromRecords` rejects a mismatched hostId outright.
 * Dropping foreign rows beats failing the whole load over one of them, and
 * doing it in one place keeps a store from quietly being the lenient one.
 */
export function filterAclRecords(hostId: string, records: readonly unknown[]): HostAclRecord[] {
  return records.filter(
    (record): record is HostAclRecord =>
      !!record && typeof record === 'object' && (record as HostAclRecord).hostId === hostId,
  );
}

/** Load the persisted records for a host, dropping anything malformed. */
export function loadAclRecords(hostId: string): HostAclRecord[] {
  // Missing key / malformed JSON / non-array all collapse to `[]`.
  return filterAclRecords(hostId, loadJson<unknown[]>(aclKey(hostId), [], Array.isArray));
}

export function saveAclRecords(hostId: string, records: readonly HostAclRecord[]): void {
  saveJson(aclKey(hostId), records);
}

/**
 * Drop this browser's copy of a host's records. Used once, when a webview hands
 * its persisted Host to a Node-resident service (`activation.ts` → adoption):
 * the copy left behind would be a second, diverging ACL for the same hostId.
 */
export function clearAclRecords(hostId: string): void {
  removeJson(aclKey(hostId));
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
