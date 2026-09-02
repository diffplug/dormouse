/**
 * Host ACL loading; see `docs/specs/remote-security-model.md` → "Host
 * Authorization". The Host runs in the process that owns the PTYs, so there is
 * no webview-resident copy to read: every caller supplies its own store.
 */

import { HostAcl, isHostAclRecord, type HostAclRecord } from 'server-lib-common';

/**
 * Keep only the records that belong to `hostId`, dropping anything that is not
 * a record at all.
 *
 * Exported because every store that reads an ACL back — the sidecar's file, VS
 * Code's `globalState` — reads it as `unknown[]`, and `HostAcl.fromRecords`
 * rejects a mismatched hostId outright. Dropping foreign rows beats failing the
 * whole load over one of them, and doing it in one place keeps a store from
 * quietly being the lenient one. It is also where a record from before the
 * end-to-end cutover is dropped, since `isHostAclRecord` requires both E2E
 * fields at their exact lengths.
 */
export function filterAclRecords(hostId: string, records: readonly unknown[]): HostAclRecord[] {
  // Shape first, then ownership. The hostId test alone admitted a record whose
  // every other field was the wrong type, and the ACL is the authorization
  // primitive — a malformed row is never useful, so dropping it is strictly
  // better than carrying it to the conjunction.
  return records.filter(
    (record): record is HostAclRecord => isHostAclRecord(record) && record.hostId === hostId,
  );
}

/**
 * Rehydrate a live `HostAcl` from persisted records, falling back to an empty
 * ACL if the stored records cannot be reconciled with `hostId`.
 *
 * `loadRecords` is required, with no default: the Host runs in the sidecar and
 * in the extension host, and a default reader would be the wrong ACL in one of
 * them — silently empty rather than loudly missing.
 */
export function loadHostAcl(
  hostId: string,
  loadRecords: (hostId: string) => HostAclRecord[],
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
