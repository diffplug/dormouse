/**
 * The setup proof: what a phone set up by scanning a Host's QR returns in its
 * pairing request to show it scanned *that* laptop's screen
 * (docs/specs/remote-security-model.md -> Pairing Ceremony).
 *
 * The QR carries two secrets with two verifiers. The Server-minted **setup
 * token** redeems at `/api/setup/*`, and the Server rightly verifies what it
 * minted. The Host-minted **setup nonce** never travels through the Server at
 * all — laptop screen to phone camera and no further — so the Client returns a
 * MAC under it rather than the nonce itself, and the Host recomputes that MAC
 * over the device key the request is actually asking to authorize.
 *
 * That binding is the whole point. A Server that substituted its own
 * `devicePublicKey` into a relayed pairing request would have to produce a
 * proof over the substituted key, which needs the nonce it has never seen — so
 * neither Server nor Client can move `verified` onto a key the person at the
 * laptop did not set up.
 */

import { lengthPrefixedConcat, toBase64Url, utf8Encode } from './bytes.js';
import { getWebCrypto, type WebCryptoLike } from './webcrypto.js';

/**
 * Domain-separation tag for the setup-proof statement. Deliberately its own,
 * distinct from `DEVICE_AUTH_DOMAIN` and `PUSH_SUBSCRIBE_DOMAIN`, for the
 * reason those are distinct from each other: "I scanned this machine's code" is
 * a different statement from "I am the Client answering this Host challenge"
 * and from "I subscribe this endpoint", and one domain per statement is what
 * stops a signature captured under one from being replayed as another. Bump the
 * version on any payload format change.
 */
export const SETUP_PROOF_DOMAIN = 'dormouse/setup-proof/v1';

/**
 * `HMAC-SHA256(key = nonce, message = domain || devicePublicKey)`, base64url.
 *
 * Both inputs are handled as opaque text rather than decoded base64url. That
 * matters most for `devicePublicKey`: the Host computes the expected proof over
 * whatever the relay put in the pairing request, so a decode step there would
 * turn a malformed frame into a thrown rejection instead of a failed compare.
 * The length prefixes make the field boundaries part of the MAC
 * (`lengthPrefixedConcat`).
 *
 * `nonce` must be non-empty — WebCrypto refuses a zero-length HMAC key — which
 * costs the caller nothing: the Host mints 32 bytes, and a phone that scanned a
 * QR with no nonce in it has nothing to prove.
 *
 * Computed identically on both ends — the phone with the nonce it scanned, the
 * Host with each nonce it still holds — so a mismatch means the pair (nonce,
 * device key) is not the one this machine displayed.
 */
export async function computeSetupProof(
  nonce: string,
  devicePublicKey: string,
  crypto: WebCryptoLike = getWebCrypto(),
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    utf8Encode(nonce),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    { name: 'HMAC' },
    key,
    lengthPrefixedConcat([utf8Encode(SETUP_PROOF_DOMAIN), utf8Encode(devicePublicKey)]),
  );
  return toBase64Url(new Uint8Array(mac));
}
