/**
 * The `#setup` hash a Host's QR carries. `docs/specs/server.md` -> Setup tokens
 * owns the grammar; `docs/specs/pocket-app.md` -> the auth screen owns what
 * Pocket does with each half.
 */

import {
  SETUP_HASH_NONCE_PARAM,
  SETUP_HASH_PREFIX,
  SETUP_HASH_TOKEN_PARAM,
  isSetupTokenHandle,
} from 'server-lib-common';

/** A scanned code, held in memory for this run only — never persisted. */
export interface ScannedSetup {
  /** Redeems once at `/api/setup/*`, in place of the setup password. */
  readonly token: string;
  /** The Host's own nonce, keyed into `computeSetupProof` at pairing time. */
  readonly nonce?: string;
}

/**
 * Read the code out of `window.location` and erase the hash, in that order.
 *
 * **Erased whether or not it parses.** A hash saying `#setup` is a credential
 * either way, and a malformed one is worth no more in the URL than a good one.
 */
export function takeSetupHash(): ScannedSetup | null {
  const { hash, pathname, search } = window.location;
  if (!hash.startsWith(SETUP_HASH_PREFIX)) return null;
  window.history.replaceState(null, '', `${pathname}${search}`);
  const params = new URLSearchParams(hash.slice(SETUP_HASH_PREFIX.length));
  const token = params.get(SETUP_HASH_TOKEN_PARAM);
  const nonce = params.get(SETUP_HASH_NONCE_PARAM);
  if (!isSetupTokenHandle(token)) return null;
  // A nonce that fails the check drops out on its own: the token still sets the
  // phone up, and pairing falls back to the fingerprint compare.
  return isSetupTokenHandle(nonce) ? { token, nonce } : { token };
}
