/**
 * Burrow ACL loading; see `docs/specs/remote-security-model.md` → "Burrow
 * Authorization". The Burrow runs in the process that owns the PTYs, so there is
 * no webview-resident copy to read: every caller supplies its own store.
 */

import { BurrowAcl, isBurrowAclRecord, type BurrowAclRecord } from 'remote-lib-common';

/**
 * Keep only the records that belong to `burrowId`, dropping anything that is not
 * a record at all.
 *
 * Exported because every store that reads an ACL back — the sidecar's file, VS
 * Code's `globalState` — reads it as `unknown[]`, and `BurrowAcl.fromRecords`
 * rejects a mismatched burrowId outright. Dropping foreign rows beats failing the
 * whole load over one of them, and doing it in one place keeps a store from
 * quietly being the lenient one. It is also where a record from before the
 * end-to-end cutover is dropped, since `isBurrowAclRecord` requires both E2E
 * fields at their exact lengths.
 */
export function filterAclRecords(burrowId: string, records: readonly unknown[]): BurrowAclRecord[] {
  // Shape first, then ownership. The burrowId test alone admitted a record whose
  // every other field was the wrong type, and the ACL is the authorization
  // primitive — a malformed row is never useful, so dropping it is strictly
  // better than carrying it to the conjunction.
  return records.filter(
    (record): record is BurrowAclRecord => isBurrowAclRecord(record) && record.burrowId === burrowId,
  );
}

/**
 * Rehydrate a live `BurrowAcl` from persisted records, falling back to an empty
 * ACL if the stored records cannot be reconciled with `burrowId`.
 *
 * `loadRecords` is required, with no default: the Burrow runs in the sidecar and
 * in the extension host, and a default reader would be the wrong ACL in one of
 * them — silently empty rather than loudly missing.
 */
export function loadBurrowAcl(
  burrowId: string,
  loadRecords: (burrowId: string) => BurrowAclRecord[],
): BurrowAcl {
  try {
    return BurrowAcl.fromRecords(burrowId, loadRecords(burrowId));
  } catch (error) {
    // Fail closed but loudly: an empty ACL silently de-pairs every client, so
    // "all my devices vanished" must at least be explicable from the console.
    console.warn(`burrow: could not load ACL for ${burrowId}; starting empty`, error);
    return new BurrowAcl(burrowId);
  }
}
