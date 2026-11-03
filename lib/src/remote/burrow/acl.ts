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

/**
 * What one revocation names (`docs/specs/remote-security-model.md` ->
 * "Revocation"): one paired browser's Client static — every active record it
 * holds — or one passkey credential, which cuts off every browser paired with
 * it.
 */
export type RevocationTarget =
  | { readonly clientStaticPublicKey: string }
  | { readonly passkeyCredentialId: string };

/** The requesters a command to the service may name: the Settings list, or `dor`. */
const COMMAND_REQUESTERS = ['settings', 'dor'] as const;

/**
 * Who asked, as the access log records it: a command's, or the Relay naming a
 * passkey its account no longer holds. A closed set.
 */
export const REVOCATION_REQUESTERS = [...COMMAND_REQUESTERS, 'relay'] as const;
export type RevocationRequester = (typeof REVOCATION_REQUESTERS)[number];

/**
 * The requester an untrusted command names, anything else read as `settings`:
 * no message can claim `relay`, which only the service's own asking logs.
 */
export function revocationRequester(value: unknown): RevocationRequester {
  return COMMAND_REQUESTERS.find((known) => known === value) ?? 'settings';
}

/** Whether `target` names a record holding these identities. */
export function revocationNames(
  target: RevocationTarget,
  record: Pick<BurrowAclRecord, 'clientStaticPublicKey' | 'passkeyCredentialId'>,
): boolean {
  return 'clientStaticPublicKey' in target
    ? record.clientStaticPublicKey === target.clientStaticPublicKey
    : record.passkeyCredentialId === target.passkeyCredentialId;
}

/**
 * Revoke what `target` names on `acl`, in place, answering the records it
 * retired as they read before. One rule for the running Burrow and for a
 * stopped one's stored ACL.
 */
export function revokeTarget(acl: BurrowAcl, target: RevocationTarget): BurrowAclRecord[] {
  const hit = acl.activeRecords().filter((record) => revocationNames(target, record));
  if ('clientStaticPublicKey' in target) acl.revokeClient(target.clientStaticPublicKey);
  else acl.revokePasskey(target.passkeyCredentialId);
  return hit;
}

/** One record per Client static, the first of each: one paired browser per entry. */
export function firstPerClientStatic(records: readonly BurrowAclRecord[]): BurrowAclRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    if (seen.has(record.clientStaticPublicKey)) return false;
    seen.add(record.clientStaticPublicKey);
    return true;
  });
}
