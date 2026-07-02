/**
 * Thin wrappers around `navigator.credentials` for the Pocket client, isolated
 * here so the protocol client (`pocket-client.ts`) can be driven with a fake in
 * vitest — the real thing needs a browser + a physical authenticator.
 *
 * Registration returns exactly what `POST /api/setup/finish` wants
 * (`{ credentialId, publicKey, clientDataJSON }`, all base64url); assertions
 * return the wire {@link PasskeyAssertion} shape the server and Host both
 * verify with `verifyPasskeyAssertion`.
 */

import { fromBase64Url, toBase64Url, utf8Encode, type PasskeyAssertion } from 'server-lib-common';

/** The result of a passkey registration, ready for `POST /api/setup/finish`. */
export interface PasskeyRegistration {
  /** `PublicKeyCredential.id` — already base64url. */
  readonly credentialId: string;
  /** Base64url SPKI from `response.getPublicKey()`. */
  readonly publicKey: string;
  /** Base64url `response.clientDataJSON` (type `webauthn.create`). */
  readonly clientDataJSON: string;
}

/** The two authenticator operations the Pocket client needs; faked in tests. */
export interface WebAuthnClient {
  registerPasskey(challenge: string, rpId: string, accountId: string): Promise<PasskeyRegistration>;
  getAssertion(challenge: string, rpId: string): Promise<PasskeyAssertion>;
}

/**
 * Create a discoverable ES256 passkey. `attestation: 'none'` keeps the server
 * dependency-free (it trusts the browser-provided SPKI key); `residentKey`
 * and `userVerification` are `'preferred'` so it works on the widest range of
 * authenticators while still preferring a resident, verified credential.
 */
/**
 * Copy into a fresh `ArrayBuffer`-backed view. WebAuthn's `BufferSource`
 * parameters demand `ArrayBuffer` (not `SharedArrayBuffer`), which the generic
 * `Uint8Array` from the byte helpers does not satisfy under recent TS libs.
 */
function toBufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function registerPasskey(
  challenge: string,
  rpId: string,
  accountId: string,
): Promise<PasskeyRegistration> {
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: toBufferSource(fromBase64Url(challenge)),
      rp: { id: rpId, name: 'Dormouse' },
      user: {
        id: toBufferSource(utf8Encode(accountId)),
        name: accountId,
        displayName: accountId,
      },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      attestation: 'none',
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('passkey creation was cancelled');
  const response = credential.response as AuthenticatorAttestationResponse;
  const spki = response.getPublicKey();
  if (!spki) throw new Error('authenticator did not return a public key (ES256 required)');
  return {
    credentialId: credential.id,
    publicKey: toBase64Url(new Uint8Array(spki)),
    clientDataJSON: toBase64Url(new Uint8Array(response.clientDataJSON)),
  };
}

/**
 * Get an assertion from any of the account's discoverable passkeys (empty
 * `allowCredentials`), bound to `challenge`. One call feeds both the sign-in
 * and the connect handshakes, so the user sees a single biometric prompt.
 */
async function getAssertion(challenge: string, rpId: string): Promise<PasskeyAssertion> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: toBufferSource(fromBase64Url(challenge)),
      rpId,
      allowCredentials: [],
      userVerification: 'preferred',
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('passkey assertion was cancelled');
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    credentialId: credential.id,
    clientDataJSON: toBase64Url(new Uint8Array(response.clientDataJSON)),
    authenticatorData: toBase64Url(new Uint8Array(response.authenticatorData)),
    signature: toBase64Url(new Uint8Array(response.signature)),
  };
}

/** The real, browser-backed implementation. */
export const browserWebAuthn: WebAuthnClient = { registerPasskey, getAssertion };
