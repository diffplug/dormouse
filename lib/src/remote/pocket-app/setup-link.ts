/**
 * The setup code a Host's QR carries, taken out of the URL at boot
 * (`docs/specs/server.md` -> Setup tokens owns the grammar).
 *
 * `#setup?token=…&nonce=…` holds two secrets with two verifiers: the token
 * redeems once at `/api/setup/*`, and the nonce never reaches the Server at all
 * — it is what a pairing request proves possession of
 * (`docs/specs/remote-security-model.md` -> Pairing Ceremony). Neither may be
 * left in the URL, which is read back by the address bar, the history stack,
 * the back button, and every screenshot of the phone.
 */

/** A scanned code, held in memory for this run only — never persisted. */
export interface ScannedSetup {
  /** Redeems once at `/api/setup/*`, in place of the setup password. */
  readonly token: string;
  /** The Host's own nonce, keyed into `computeSetupProof` at pairing time. */
  readonly nonce?: string;
}

/**
 * Both halves are base64url — 32 random bytes each today, so 43 characters —
 * bounded well past that and far short of anything worth defending against
 * downstream. A value outside it was not minted by a Host.
 */
const SETUP_SECRET = /^[A-Za-z0-9_-]{1,128}$/;

const HASH_PREFIX = '#setup?';

/**
 * Read the code out of `loc` and erase the hash, in that order.
 *
 * **Erased whether or not it parses.** A hash saying `#setup` is a credential
 * either way, and a malformed one is worth no more in the URL than a good one.
 *
 * **A malformed code is ignored, not reported.** The person holding the phone
 * did not type this and cannot fix it, so the app falls through to the ordinary
 * password/sign-in screen rather than raising an error about a URL.
 */
export function takeSetupHash(
  loc: Location = window.location,
  hist: History = window.history,
): ScannedSetup | null {
  const hash = loc.hash;
  if (!hash.startsWith(HASH_PREFIX)) return null;
  hist.replaceState(null, '', `${loc.pathname}${loc.search}`);
  const params = new URLSearchParams(hash.slice(HASH_PREFIX.length));
  const token = params.get('token');
  const nonce = params.get('nonce');
  if (token === null || !SETUP_SECRET.test(token)) return null;
  // A nonce that fails the check drops out on its own: the token still sets the
  // phone up, and pairing falls back to the fingerprint compare.
  return nonce !== null && SETUP_SECRET.test(nonce) ? { token, nonce } : { token };
}

/**
 * The code this run was opened with, captured at module load.
 *
 * Not a `useMemo` or a `useRef` initializer: StrictMode renders a mounting tree
 * twice, and the second pass would re-read a hash the first pass had already
 * erased and conclude there was no code.
 */
export const scannedSetup: ScannedSetup | null = takeSetupHash();
