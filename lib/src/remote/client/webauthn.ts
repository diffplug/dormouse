/**
 * Thin wrappers around `navigator.credentials` for the Pocket client, isolated
 * here so the protocol client (`pocket-client.ts`) can be driven with a fake in
 * vitest — the real thing needs a browser + a physical authenticator.
 *
 * Registration returns exactly what `POST /api/setup/finish` wants
 * (`{ credentialId, publicKey, clientDataJSON }`, all base64url); assertions
 * return the wire {@link PasskeyAssertion} shape the Relay and Host both
 * verify with `verifyPasskeyAssertion`.
 */

import { fromBase64Url, toBase64Url, utf8Encode, type PasskeyAssertion } from 'remote-lib-common';

/** Shown when this device already holds a passkey the Relay has registered. */
export const PASSKEY_ALREADY_REGISTERED_MESSAGE =
  'This device already has a passkey for this Relay. Sign in with it instead.';

/**
 * The authenticator refused to create a credential because one named in
 * `excludeCredentials` is already on it. Its own class, like
 * `SetupTokenInvalidError`, because the UI must act rather than report: the
 * exclusion list is what the *Relay* holds, so this is proof that a sign-in
 * from this very device will work — the one case where prior use is certain
 * even when this browser stored nothing.
 */
export class PasskeyAlreadyRegisteredError extends Error {
  constructor() {
    super(PASSKEY_ALREADY_REGISTERED_MESSAGE);
    this.name = 'PasskeyAlreadyRegisteredError';
  }
}

/**
 * Whether `navigator.credentials.create()` failed for that reason. Matched on
 * `name`, not `instanceof DOMException`: the error crosses realms (an installed
 * app's window, a polyfilled authenticator, a test fake) and the name is the
 * only part guaranteed to survive the trip.
 */
export function isPasskeyAlreadyRegistered(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  return (err as { name?: unknown }).name === 'InvalidStateError';
}

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
  /**
   * Create a passkey for `accountId`. Pass `excludeCredentialIds` (base64url,
   * from `SetupBeginResponse`) to stop the authenticator minting a duplicate of
   * a credential the Relay already holds.
   */
  registerPasskey(
    challenge: string,
    rpId: string,
    accountId: string,
    excludeCredentialIds?: readonly string[],
  ): Promise<PasskeyRegistration>;
  /**
   * Get an assertion bound to `challenge`. Pass `allowCredentials` (base64url
   * credential ids) to scope selection to specific passkeys; leave it empty to
   * discover any of the account's resident credentials.
   */
  getAssertion(
    challenge: string,
    rpId: string,
    allowCredentials?: readonly string[],
  ): Promise<PasskeyAssertion>;
}

/**
 * Copy into a fresh `ArrayBuffer`-backed view. WebAuthn's `BufferSource`
 * parameters demand `ArrayBuffer` (not `SharedArrayBuffer`), which the generic
 * `Uint8Array` from the byte helpers does not satisfy under recent TS libs.
 */
function toBufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Create a discoverable ES256 passkey. `attestation: 'none'` keeps the Relay
 * dependency-free (it trusts the browser-provided SPKI key).
 *
 * **ES256 alone in `pubKeyCredParams` is deliberate, and Chrome warns about
 * it**: the verifier accepts nothing else
 * (`remote-lib-common/src/security/passkey.ts`), so offering RS256 would only
 * mint keys that fail at the first assertion. Expected in every run's console
 * (`scripts/pairing-walkthrough/README.md`). `residentKey`
 * is `'required'`: sign-in discovers credentials with an empty
 * `allowCredentials`, so a non-resident credential (which `'preferred'` can
 * silently produce) would register fine and then never be able to sign in —
 * better to fail here, where re-running setup is a one-tap recovery.
 *
 * `excludeCredentialIds` is the account's registered passkeys as the *Relay*
 * knows them, so the authenticator refuses a duplicate of one that can already
 * sign in, while an orphan it holds — created, then refused at `finish` — is
 * absent from the list and correctly replaced rather than blocking setup.
 */
async function registerPasskey(
  challenge: string,
  rpId: string,
  accountId: string,
  excludeCredentialIds: readonly string[] = [],
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
      excludeCredentials: excludeCredentialIds.map((id) => ({
        type: 'public-key',
        id: toBufferSource(fromBase64Url(id)),
      })),
      authenticatorSelection: {
        residentKey: 'required',
        // WebAuthn L1 authenticators ignore `residentKey`; this is its spelling.
        requireResidentKey: true,
        userVerification: 'preferred',
      },
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
 * Get an assertion bound to `challenge`. Sign-in leaves `allowCredentials` empty
 * to discover any of the account's resident passkeys; connect passes the stored
 * credential id(s) so the authenticator selects a passkey this device can verify
 * (with several synced passkeys for one rpId, an empty list lets the OS pick one
 * whose public key we never stored). One call feeds both handshakes, so the user
 * sees a single biometric prompt.
 */
async function getAssertion(
  challenge: string,
  rpId: string,
  allowCredentials: readonly string[] = [],
): Promise<PasskeyAssertion> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: toBufferSource(fromBase64Url(challenge)),
      rpId,
      allowCredentials: allowCredentials.map((id) => ({
        type: 'public-key',
        id: toBufferSource(fromBase64Url(id)),
      })),
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
