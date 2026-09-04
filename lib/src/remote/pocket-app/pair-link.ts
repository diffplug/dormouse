/**
 * What Pocket does with a `#pair?` fragment the **native camera** delivered:
 * nothing but erase it.
 *
 * A code opened from the phone's camera is origin bootstrap only
 * (`docs/specs/pocket-app.md`). The keys a pairing mints have to be created in
 * the context that will own them — on iOS, the Home Screen install is a
 * different storage partition from the Safari tab a camera opens — so the run
 * that arrives this way spends nothing, retains nothing, and asks the user to
 * scan again from inside Pocket. `docs/specs/server.md` → Setup tokens owns the
 * grammar this only ever looks at the prefix of.
 */

import { PAIRING_HASH_PREFIX } from 'remote-lib-common';

/**
 * Erase a pairing fragment from the address bar, answering whether one was
 * there.
 *
 * **Read and erased before the first render, and never parsed.** A hash saying
 * `#pair?` carries a live setup token whether or not the rest of it is
 * well-formed, and an address bar, a history stack, and a screenshot are no
 * place for one — so the erase is unconditional and nothing is kept from it,
 * not even a parse result.
 */
export function takePairingHash(): boolean {
  const { hash, pathname, search } = window.location;
  if (!hash.startsWith(PAIRING_HASH_PREFIX)) return false;
  window.history.replaceState(null, '', `${pathname}${search}`);
  return true;
}
